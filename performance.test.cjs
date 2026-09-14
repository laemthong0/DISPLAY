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
  const properties = new Map();
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
      mode: 'push_meta', meta: { wall: { screen: i % 2 + 1 }, updatedAt: i,
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
  const response = context.doGet({ parameter: { mode: 'pull_meta', callback: 'cb' } });
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
    fetch: (url, options) => { writes.push(JSON.parse(options.body)); return new Promise(resolve => pending.push(resolve)); }
  });
  vm.runInContext(extract(display, 'pushRemoteMeta'), context);
  context.pushRemoteMeta({ n: 1 }); context.pushRemoteMeta({ n: 2 }); context.pushRemoteMeta({ n: 3 });
  assert.equal(writes.length, 1);
  pending.shift()(); await delay(0);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].meta.n, 3);
  pending.shift()(); await delay(0);
  assert.equal(context.remoteMetaInFlight, false);
});
test('refresh sends exactly one local command and one remote write', () => {
  const local = [], remote = [];
  const context = vm.createContext({ getControlClientId: () => 'client', lastIssuedCommandAt: 0,
    postLocalCommand: command => local.push(command), getWebAppUrl: () => 'endpoint',
    navigator: {}, fetch: (url, options) => { remote.push(JSON.parse(options.body)); return Promise.resolve(); }
  });
  vm.runInContext(extract(control, 'sendCommand'), context);
  context.sendCommand('refresh');
  assert.equal(local.length, 1);
  assert.equal(remote.length, 1);
  assert.equal(local[0].id, remote[0].command.id);
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
