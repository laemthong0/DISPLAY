const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const display = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const control = fs.readFileSync(`${__dirname}/control.html`, 'utf8');
const backend = fs.readFileSync(`${__dirname}/Code.gs`, 'utf8');
function extract(source, name) {
  const start = source.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n    (?:async )?function /);
  return next < 0 ? rest : rest.slice(0, next);
}
const delay = (ms, result, fail = false) => new Promise((resolve, reject) => {
  setTimeout(() => fail ? reject(new Error('source failed')) : resolve(result), ms);
});

test('inline scripts and backend parse; release versions agree', () => {
  for (const source of [display, control]) {
    for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      new vm.Script(match[1]);
    }
    assert.equal(source.match(/const APP_VERSION = "([^"]+)"/)[1],
      JSON.parse(fs.readFileSync(`${__dirname}/version.json`)).version);
  }
  new vm.Script(backend);
});

test('heartbeat persists two screens, strips aggregate, releases lock and supports pull', () => {
  const properties = new Map([['TV_DISPLAY_AUTH_TOKEN', 'test-token']]);
  let locked = false;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value)
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { assert.equal(locked, false); locked = true; return true; },
      releaseLock: () => { locked = false; }
    }) },
    ContentService: { MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput: text => ({ setMimeType: () => text }) }
  });
  vm.runInContext(backend, context);
  for (let i = 0; i < 100; i++) {
    const previous = JSON.parse(properties.get('TV_DISPLAY_META_V1') || '{}');
    const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
      mode: 'push_meta', token: 'test-token', meta: { wall: { screen: i % 2 + 1 }, updatedAt: i,
        screens: previous.screens }
    }) } }));
    assert.equal(result.ok, true);
    assert.equal(locked, false);
  }
  const stored = JSON.parse(properties.get('TV_DISPLAY_META_V1'));
  assert.equal(Object.keys(stored.screens).length, 2);
  assert.equal(stored.screens['1'].screens, undefined);
  assert.equal(stored.screens['2'].screens, undefined);
  assert.ok(JSON.stringify(stored).length < 500);
  const response = context.doGet({ parameter: { mode: 'pull_meta', callback: 'cb', token: 'test-token' } });
  assert.equal(JSON.parse(response.slice(3, -2)).meta.updatedAt, 99);
});

function rowLoader(remote, fallback) {
  const context = vm.createContext({ fetchRowsFromRemote: remote, fetchJsonp: fallback,
    setTimeout: (fn) => setTimeout(fn, 5), clearTimeout });
  vm.runInContext(extract(display, 'fetchSheetRows'), context);
  return context.fetchSheetRows;
}
test('fast GAS avoids fallback, including an empty sheet', async () => {
  let calls = 0;
  const rows = [];
  const load = rowLoader(() => Promise.resolve(rows), () => { calls++; return Promise.resolve([['fallback']]); });
  assert.equal(await load('id', 'sheet'), rows);
  await delay(10);
  assert.equal(calls, 0);
});
test('slow GAS does not block the public sheet fallback', async () => {
  const rows = [['fallback']];
  const load = rowLoader(() => delay(30, [['remote']]), () => Promise.resolve(rows));
  assert.equal(await load('id', 'sheet'), rows);
});
test('private-sheet fallback failure still accepts slow GAS', async () => {
  const rows = [['private']];
  const load = rowLoader(() => delay(15, rows), () => Promise.reject(new Error('private sheet')));
  assert.equal(await load('id', 'sheet'), rows);
});
test('GAS failure starts fallback immediately and both failures reject', async () => {
  const load = rowLoader(() => Promise.resolve(null), () => Promise.reject(new Error('offline')));
  await assert.rejects(load('id', 'sheet'), /offline/);
});
test('background preload limits concurrency to two and skips active sheet', async () => {
  let active = 0, maximum = 0;
  const loaded = [];
  const context = vm.createContext({ startLoopsRunId: 1, data: { sheetPages: ['a','b','c','d','e'] },
    loadSheetData: async index => {
      active++; maximum = Math.max(maximum, active); loaded.push(index);
      await delay(2); active--;
    }
  });
  vm.runInContext(extract(display, 'loadRemainingSheets'), context);
  await context.loadRemainingSheets(1, 2);
  assert.equal(maximum, 2);
  assert.deepEqual(loaded.sort(), [0,1,3,4]);
  context.startLoopsRunId = 2;
  await context.loadRemainingSheets(1, 2);
  assert.equal(loaded.length, 4);
});
test('command polling ignores overlap and backs off after failures', async () => {
  let calls = 0;
  let finish;
  const context = vm.createContext({ getControlWebAppUrl: () => 'endpoint', navigator: { onLine: true },
    remoteControlPollInFlight: false, remoteControlNextPollAt: 0, remoteControlFailures: 0,
    lastRemoteCommandId: null, REMOTE_COMMAND_TIMEOUT_MS: 20000, REMOTE_CONTROL_POLL_MS: 500,
    runJsonp: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    acceptRemoteCommand: () => {}
  });
  vm.runInContext(extract(display, 'pullRemoteCommand'), context);
  context.pullRemoteCommand(); context.pullRemoteCommand();
  assert.equal(calls, 1);
  finish({ ok: false, error: 'busy' });
  await delay(0);
  assert.equal(context.remoteControlPollInFlight, false);
  assert.equal(context.remoteControlFailures, 1);
  assert.ok(context.remoteControlNextPollAt > Date.now());
  context.pullRemoteCommand();
  assert.equal(calls, 1);
});
test('heartbeat coalesces pending snapshots while a write is in flight', async () => {
  const writes = [], pending = [];
  const context = vm.createContext({ getControlWebAppUrl: () => 'endpoint', navigator: { onLine: true },
    remoteMetaInFlight: false, pendingRemoteMeta: null, data: { sheetId: 'id' },
    getControlAuthToken: () => 'test-token',
    fetch: (url, options) => { writes.push(JSON.parse(options.body)); return new Promise(resolve => pending.push(resolve)); }
  });
  vm.runInContext(extract(display, 'pushRemoteMeta'), context);
  context.pushRemoteMeta({ n: 1 }); context.pushRemoteMeta({ n: 2 }); context.pushRemoteMeta({ n: 3 });
  assert.equal(writes.length, 1);
  pending.shift()(); await delay(0);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].meta.n, 3);
  assert.equal(writes[0].token, 'test-token');
  pending.shift()(); await delay(0);
  assert.equal(context.remoteMetaInFlight, false);
});
test('refresh sends exactly one local command and one remote write', () => {
  const local = [], remote = [];
  const context = vm.createContext({ getControlClientId: () => 'client', lastIssuedCommandAt: 0,
    getControlAuthToken: () => 'test-token',
    postLocalCommand: command => local.push(command), getWebAppUrl: () => 'endpoint',
    navigator: {}, fetch: (url, options) => { remote.push(JSON.parse(options.body)); return Promise.resolve(); }
  });
  vm.runInContext(extract(control, 'sendCommand'), context);
  context.sendCommand('refresh');
  assert.equal(local.length, 1);
  assert.equal(remote.length, 1);
  assert.equal(local[0].id, remote[0].command.id);
  assert.equal(remote[0].token, 'test-token');
});
test('startup starts product loading before the slow sheet directory responds', async () => {
  let finishDirectory;
  const loaded = [];
  const context = vm.createContext({ startLoopsRunId: 0, sheetTimer: null, currentPageIndex: 0,
    clearInterval: () => {}, setInterval: () => 1,
    restartRemoteControlPolling: () => {}, restartHealthHeartbeat: () => {},
    loadSheetData: index => { loaded.push(index); return Promise.resolve(); },
    syncSheetPagesFromRemote: () => new Promise(resolve => { finishDirectory = resolve; }),
    render: () => {}, getSheetRefreshMs: () => 60000,
    restartPageTimer: () => {}, loadRemainingSheets: () => {}
  });
  vm.runInContext(extract(display, 'startLoops'), context);
  const startup = context.startLoops();
  assert.deepEqual(loaded, [0]);
  finishDirectory(false);
  await startup;
});

test('product search finds a matching product in another brand tab and its subcategory', () => {
  const context = vm.createContext({
    data: { sheetPages: ['แบรนด์ A', 'ยารา'] }, currentPageIndex: 0,
    currentMotherSubIndex: 0, currentSubPageIndex: 0,
    productsCache: { 'แบรนด์ A': [{ name: 'สินค้า A' }], 'ยารา': [{ name: 'ยารา 16-16-16' }] },
    clean: value => String(value || '').trim(),
    getProductsForSheetState: sheet => context.productsCache[sheet] || null,
    getSubCategoriesForSheet: sheet => sheet === 'ยารา' ? ['ปุ๋ยเกล็ด'] : ['ทั่วไป'],
    getVisibleProductsForState: sheet => context.productsCache[sheet],
    productMatchesFilter: (item, query) => item.name.includes(query), saveDisplayState: () => {}
  });
  vm.runInContext(extract(display, 'findProductSearchTarget'), context);
  vm.runInContext(extract(display, 'focusProductSearchMatch'), context);
  assert.equal(context.focusProductSearchMatch('ยารา'), true);
  assert.equal(context.currentPageIndex, 1);
});

test('wall rotation accepts a brand tab containing one product', () => {
  assert.match(display, /const WALL_MULTI_SCREEN_MIN_ITEMS = 1;/);
});

function backendHarness(initialToken = 'test-token') {
  const properties = new Map(initialToken ? [['TV_DISPLAY_AUTH_TOKEN', initialToken]] : []);
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value)
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput: text => ({ setMimeType: () => text }) }
  });
  vm.runInContext(backend, context);
  return { context, properties,
    post: body => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } })),
    get: params => JSON.parse(context.doGet({ parameter: { callback: 'cb', ...params } }).slice(3, -2)) };
}

test('backend rejects missing configuration, missing token and wrong token before writes', () => {
  const unconfigured = backendHarness('');
  assert.equal(unconfigured.get({ mode: 'pull_meta' }).error, 'unauthorized');
  assert.equal(unconfigured.post({ mode: 'push_command', command: { id: 'a', action: 'next' } }).error, 'unauthorized');
  const configured = backendHarness();
  for (const token of ['', 'wrong']) {
    assert.equal(configured.get({ mode: 'pull_meta', token }).error, 'unauthorized');
    assert.equal(configured.post({ mode: 'push_meta', token, meta: {} }).error, 'unauthorized');
  }
  assert.equal(configured.properties.has('TV_DISPLAY_META_V1'), false);
  assert.equal(configured.get({ mode: 'pull_meta', token: 'test-token' }).ok, true);
});

test('commands expire by server time; legacy commands and retries cannot replay', () => {
  const h = backendHarness();
  const pull = () => h.get({ mode: 'pull_command', token: 'test-token' });
  h.properties.set('TV_DISPLAY_CMD_V1', JSON.stringify({ id: 'legacy', action: 'next' }));
  assert.equal(pull().command, null);
  h.properties.set('TV_DISPLAY_CMD_V1', JSON.stringify({ id: 'old', action: 'next', serverReceivedAt: Date.now() - 61000 }));
  assert.equal(pull().command, null);
  const command = { id: 'new', action: 'next', createdAt: 1, serverReceivedAt: 1 };
  assert.equal(h.post({ mode: 'push_command', token: 'test-token', command }).ignored, false);
  assert.equal(pull().command.id, 'new');
  assert.ok(pull().command.serverReceivedAt > Date.now() - 1000);
  assert.equal(h.post({ mode: 'push_command', token: 'test-token', command }).ignored, true);
  assert.equal(h.get({ mode: 'pull_command', token: 'test-token', lastId: 'new' }).command, null);
});

test('reloaded displays remember last command separately for each screen and backend', () => {
  const storage = new Map(), handled = [];
  function client(screen, endpoint = 'https://backend-a') {
    const c = vm.createContext({ clean: x => String(x ?? '').trim(),
      LAST_REMOTE_COMMAND_KEY: 'last', WALL_CONFIG: { screen },
      getControlWebAppUrl: () => endpoint,
      localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
      seenRemoteCommandKeys: new Map(), REMOTE_COMMAND_DEDUPE_TTL_MS: 15000,
      handleRemoteCommand: cmd => handled.push(cmd.id) });
    for (const name of ['getRemoteCommandStorageKey', 'readLastRemoteCommandId', 'rememberRemoteCommandId',
      'pruneRemoteCommandKeys', 'getRemoteCommandKey', 'acceptRemoteCommand']) vm.runInContext(extract(display, name), c);
    c.lastRemoteCommandId = c.readLastRemoteCommandId();
    return c;
  }
  const command = { id: 'a', action: 'next' };
  assert.equal(client(1).acceptRemoteCommand(command), true);
  assert.equal(client(1).acceptRemoteCommand(command), false);
  assert.equal(client(2).acceptRemoteCommand(command), true);
  assert.equal(client(1, 'https://backend-b').acceptRemoteCommand(command), true);
  assert.equal(handled.length, 3);
});

test('both JSONP clients include the configured token', async () => {
  for (const source of [display, control]) {
    let requested;
    const win = {};
    const context = vm.createContext({ URL, window: win, setTimeout, clearTimeout,
      getControlAuthToken: () => 'test-token',
      document: { createElement: () => ({}), body: { appendChild: script => {
        requested = new URL(script.src);
        win[requested.searchParams.get('callback')]({ ok: true });
      } } } });
    vm.runInContext(extract(source, 'runJsonp'), context);
    assert.equal((await context.runJsonp('https://script.google.com/macros/s/test/exec', { mode: 'pull_meta' })).ok, true);
    assert.equal(requested.searchParams.get('token'), 'test-token');
  }
});

test('autoplay starts, stops and avoids rewriting storage during cross-tab updates', () => {
  let preference = 'paused', writes = 0, starts = 0, stops = 0;
  const c = vm.createContext({ autoPlayEnabled: false, AUTO_PLAY_KEY: 'play', render() {},
    localStorage: { getItem: () => preference, setItem: (_, value) => { preference = value; writes++; } },
    restartPageTimer: () => starts++, stopPageTimer: () => stops++ });
  vm.runInContext(extract(display, 'setAutoPlay'), c);
  c.setAutoPlay(true); assert.equal(c.autoPlayEnabled, true); assert.equal(preference, 'playing');
  c.setAutoPlay(true); assert.equal(writes, 1);
  c.setAutoPlay(false); assert.equal(c.autoPlayEnabled, false); assert.equal(stops, 1); assert.equal(starts, 2);
});

function sheetLoaderHarness() {
  const renders = [];
  const c = vm.createContext({ data: { sheetPages: ['A', 'B'], sheetId: 'sheet-1' },
    currentPageIndex: 0, currentMotherSubIndex: 0, currentSubPageIndex: 0,
    productFilterQuery: 'target', productsCache: { A: [{ name: 'other' }] },
    clean: x => String(x ?? '').trim(), getSheetName: () => c.data.sheetPages[c.currentPageIndex],
    sheetLoadInFlight: new Map(), sheetLoadErrors: {}, navigator: { onLine: true },
    readSheetProductsFallback: () => null, writeSheetProductsFallback() {},
    $: () => ({ classList: { remove() {} } }), setGridRefreshing() {}, updateClock() {},
    WALL_CONFIG: { syncEnabled: false }, getProductsDataSignature: p => JSON.stringify(p),
    fetchSheetRows: async () => [['target']], parseRows: rows => rows.map(row => ({ name: row[0] })),
    getVisibleProducts: (_, products) => products, applyProductFilter: products => products.filter(p => p.name === c.productFilterQuery),
    focusProductSearchMatch: () => { c.currentPageIndex = 1; return true; },
    skipCurrentEmptyState: () => false,
    render: () => renders.push({ page: c.currentPageIndex, names: c.productsCache[c.getSheetName()].map(p => p.name) }) });
  vm.runInContext(extract(display, 'loadSheetData'), c);
  return { c, renders };
}

test('search repaints when the matching sheet finishes loading in the background', async () => {
  const { c, renders } = sheetLoaderHarness();
  await c.loadSheetData(1);
  assert.equal(c.currentPageIndex, 1);
  assert.deepEqual(renders, [{ page: 1, names: ['target'] }]);
});

test('background loads preserve an existing search result page', async () => {
  const { c } = sheetLoaderHarness();
  c.productsCache.A = [{ name: 'target' }]; c.currentSubPageIndex = 2;
  c.focusProductSearchMatch = () => { throw new Error('must not reset an existing match'); };
  await c.loadSheetData(1);
  assert.equal(c.currentPageIndex, 0); assert.equal(c.currentSubPageIndex, 2);
});

test('a late response from the old spreadsheet cannot contaminate new sheet data', async () => {
  const { c } = sheetLoaderHarness();
  let finish; c.fetchSheetRows = () => new Promise(resolve => { finish = resolve; });
  const pending = c.loadSheetData(1);
  c.data.sheetId = 'sheet-2'; finish([['old source']]); await pending;
  assert.equal(c.productsCache.B, undefined); assert.equal(c.sheetLoadInFlight.size, 0);
});

test('service worker preserves other projects, bounds shell keys and bypasses version checks', async () => {
  const handlers = {}, removed = [], cachedKeys = [];
  let offline = false;
  const cache = { match: async key => ({ offline: key }), put: async key => cachedKeys.push(key) };
  const c = vm.createContext({ URL, Set,
    self: { location: { origin: 'https://example.com', href: 'https://example.com/DISPLAY/sw.js' },
      addEventListener: (name, fn) => { handlers[name] = fn; }, clients: { claim() {} } },
    caches: { keys: async () => ['laemthong-display-shell-v5', 'laemthong-display-shell-v7', 'other-app'],
      delete: async key => removed.push(key), open: async () => cache },
    fetch: async () => { if (offline) throw new Error('offline'); return { ok: true, clone: () => ({}) }; } });
  vm.runInContext(fs.readFileSync(`${__dirname}/sw.js`, 'utf8'), c);
  let pending; handlers.activate({ waitUntil: p => { pending = p; } }); await pending;
  assert.deepEqual(removed, ['laemthong-display-shell-v5']);
  for (const suffix of ['?_ts=1', '?_ts=2']) {
    handlers.fetch({ request: { method: 'GET', url: 'https://example.com/DISPLAY/index.html' + suffix },
      respondWith: p => { pending = p; } }); await pending;
  }
  assert.equal(new Set(cachedKeys).size, 1);
  assert.equal(cachedKeys[0], 'https://example.com/DISPLAY/index.html');
  offline = true;
  handlers.fetch({ request: { method: 'GET', url: 'https://example.com/DISPLAY/control.html?_ts=3' }, respondWith: p => { pending = p; } });
  assert.equal((await pending).offline, 'https://example.com/DISPLAY/control.html');
  for (const url of ['https://example.com/DISPLAY/version.json?_=1', 'https://example.com/OTHER/index.html']) {
    handlers.fetch({ request: { method: 'GET', url }, respondWith: () => assert.fail('must not intercept') });
  }
});

test('display and controller use shared code configuration and ignore old browser settings', () => {
  const configSource = fs.readFileSync(`${__dirname}/display-config.js`, 'utf8');
  for (const source of [display, control]) {
    const c = vm.createContext({ window: {}, URLSearchParams,
      clean: value => String(value ?? '').trim(),
      localStorage: { getItem: () => 'obsolete-browser-setting' } });
    c.window.location = { search: '' };
    vm.runInContext(configSource, c);
    vm.runInContext(extract(source, 'getControlAuthToken'), c);
    assert.equal(c.getControlAuthToken(), c.window.DISPLAY_CONFIG.controlAuthToken);
    assert.ok(c.getControlAuthToken().length >= 32);
    if (source === control) {
      vm.runInContext(extract(source, 'validWebAppUrl'), c);
      vm.runInContext(extract(source, 'getWebAppUrl'), c);
      assert.equal(c.getWebAppUrl(), c.window.DISPLAY_CONFIG.controlWebAppUrl);
    } else {
      vm.runInContext(extract(source, 'getControlWebAppUrl'), c);
      assert.equal(c.getControlWebAppUrl(), c.window.DISPLAY_CONFIG.controlWebAppUrl);
      c.window.location.search = '?remote=0';
      assert.equal(c.getControlWebAppUrl(), '');
    }
    assert.ok(source.indexOf('src="display-config.js?') < source.indexOf('const APP_VERSION'));
  }
  assert.doesNotMatch(control, /id="(?:gasUrlInput|gasTokenInput|btnSaveGasUrl)"/);
  assert.doesNotMatch(display, /id="(?:editControlAuthToken|editControlWebAppUrl)"/);
});

function pricingContext() {
  const c = vm.createContext({ clean: x => String(x ?? '').trim(),
    isProductVisible: item => !!item.name && item.status !== 'ซ่อน' });
  for (const name of ['formatPrice', 'parsePriceNumber', 'getProductPriceState', 'parseRows',
    'getSortablePriceValue', 'sortProductsByPriceAsc', 'getProductsDataSignature']) {
    vm.runInContext(extract(display, name), c);
  }
  return c;
}

test('discount column I preserves original price, categories and badges without mutating source rows', () => {
  const c = pricingContext();
  const rows = [['ชื่อสินค้า','รายละเอียด','ราคา','หน่วย','รูป','สถานะ','หมวดย่อย','ป้ายพิเศษ','ราคาหลังลด'],
    ['ปุ๋ย A','detail','฿1,200','บ.','image','แสดง','cat','โปรโมชั่น','฿1,050'],
    ['ปุ๋ย B','','800','บ.','','ซ่อน','','','700']];
  const products = c.parseRows(rows);
  assert.equal(rows.length, 3); assert.equal(products.length, 1);
  assert.equal(products[0].price, '1,200'); assert.equal(products[0].discountPrice, '฿1,050');
  assert.equal(products[0].subCategory, 'cat'); assert.equal(products[0].specialBadge, 'โปรโมชั่น');
  assert.equal(c.getProductPriceState(products[0]).current, '1,050');
});

test('blank, invalid, zero, negative and non-lower sale prices leave the original price visible', () => {
  const c = pricingContext();
  for (const discountPrice of ['', 'สอบถาม', '0', '-100', '600', '650', '10%', '500-550']) {
    const state = c.getProductPriceState({ price: '600', discountPrice });
    assert.equal(state.discounted, false); assert.equal(state.current, '600');
  }
  const state = c.getProductPriceState({ price: '฿๑,๒๐๐.๕๐', discountPrice: '๑,๐๕๐.๒๕ บาท' });
  assert.equal(state.current, '1,050.25'); assert.equal(state.discounted, true);
  assert.equal(c.getProductPriceState({ price: 'สอบถาม', discountPrice: '500' }).discounted, false);
});

test('existing compact and eight-column sheets still parse without discounted prices', () => {
  const c = pricingContext();
  assert.equal(c.parseRows([['ชื่อสินค้า','ราคา'],['ปุ๋ย A','600']])[0].price, '600');
  assert.equal(c.parseRows([['ปุ๋ย A','','600','บ.','','แสดง','','']])[0].discountPrice, '');
});

test('sorting and change detection follow a changed discounted price', () => {
  const c = pricingContext();
  const a = { name: 'A', price: '1000', discountPrice: '500' }, b = { name: 'B', price: '600' };
  assert.equal(c.sortProductsByPriceAsc([b,a])[0].name, 'A');
  const old = c.getProductsDataSignature([a]);
  a.discountPrice = '450'; assert.notEqual(c.getProductsDataSignature([a]), old);
  c.getSpecialBadgeLabel = () => '';
  vm.runInContext(extract(display, 'getGridRenderSignature'), c);
  const rendered = c.getGridRenderSignature([a], {}, '', {});
  a.discountPrice = '400'; assert.notEqual(c.getGridRenderSignature([a], {}, '', {}), rendered);
});

test('backend includes column I and uses a new cache namespace for nine-column rows', () => {
  const h = backendHarness(); let requestedColumns = 0, key;
  h.context.CacheService = { getScriptCache: () => ({ get: value => { key = value; return null; }, put() {} }) };
  h.context.SpreadsheetApp = { openById: () => ({ getSheetByName: () => ({
    getLastRow: () => 2, getLastColumn: () => 12,
    getRange: (_, __, ___, columns) => { requestedColumns = columns; return { getDisplayValues: () => [['ชื่อสินค้า','','ราคา','','','','','','ราคาหลังลด'],['A','','600','','','','','','550']] }; }
  }) }) };
  const result = h.get({ mode: 'pull_sheet_rows', token: 'test-token', sheetName: 'แม่ปุ๋ย' });
  assert.equal(result.rows[1][8], '550'); assert.equal(requestedColumns, 9); assert.ok(key.startsWith('rows-v2:'));
});

test('old backend data triggers public source rather than silently omitting discount column', async () => {
  const c = vm.createContext({ getControlWebAppUrl: () => 'endpoint',
    runJsonp: async () => ({ ok: true, rows: [['ชื่อสินค้า','','ราคา','','','','','ป้ายพิเศษ'],['A','','600']] }) });
  vm.runInContext(extract(display, 'fetchRowsFromRemote'), c);
  assert.equal(await c.fetchRowsFromRemote('id', 'แม่ปุ๋ย'), null);
  c.runJsonp = async () => ({ ok: true, rows: [['ชื่อสินค้า','','ราคา','','','','','','ราคาหลังลด'],['A','','600','','','','','','550']] });
  assert.equal((await c.fetchRowsFromRemote('id', 'แม่ปุ๋ย'))[1][8], '550');
});
