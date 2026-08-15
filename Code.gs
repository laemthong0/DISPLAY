const KEY_META = 'TV_DISPLAY_META_V1';
const KEY_CMD = 'TV_DISPLAY_CMD_V1';
const KEY_CMD_HISTORY = 'TV_DISPLAY_CMD_HISTORY_V1';
const KEY_SHEET_ID = 'TV_DISPLAY_SHEET_ID';
const KEY_AUTH_TOKEN = 'TV_DISPLAY_AUTH_TOKEN';
const KEY_ALLOWED_SHEET_IDS = 'TV_DISPLAY_ALLOWED_SHEET_IDS';
const DEFAULT_SPREADSHEET_ID = '166Ija7H3Dal4qA4ZokEJVEBXGY1BhW1DWb1pIXw_OgI';
const HIDDEN_SHEET_NAMES = ['price'];
const GAS_CACHE_TTL_SECONDS = 30;

function doGet(e) {
  const mode = ((e && e.parameter && e.parameter.mode) || '').trim();
  const callback = ((e && e.parameter && e.parameter.callback) || '').trim();
  const sheetId = ((e && e.parameter && e.parameter.sheetId) || '').trim();

  if (!isAuthorized_(getRequestToken_(e))) {
    return asJsonp(callback, { ok: false, error: 'unauthorized' });
  }

  if (mode === 'pull_meta') {
    const metaRaw = PropertiesService.getScriptProperties().getProperty(KEY_META);
    const meta = safeParseJson_(metaRaw, null);
    // Keep the control heartbeat fast. The display already publishes the
    // current page list in meta; scanning the spreadsheet here can block the
    // request long enough for the control page's JSONP timeout to expire.
    return asJsonp(callback, { ok: true, meta: meta });
  }

  if (mode === 'pull_sheet_pages') {
    return asJsonp(callback, {
      ok: true,
      sheetPages: getLiveSheetPages_(sheetId)
    });
  }

  if (mode === 'pull_sheet_rows') {
    const sheetName = ((e && e.parameter && e.parameter.sheetName) || '').trim();
    const result = getSheetRows_(sheetId, sheetName);
    return asJsonp(callback, {
      ok: result.ok,
      rows: result.rows,
      error: result.error || ''
    });
  }

  if (mode === 'pull_command') {
    const lastId = ((e && e.parameter && e.parameter.lastId) || '').trim();
    const properties = PropertiesService.getScriptProperties();
    const current = safeParseJson_(properties.getProperty(KEY_CMD), null);
    // Multi-device controls must always receive the newest command.
    // Replaying history makes the display process stale commands one by one.
    if (!current || !current.id || current.id === lastId) {
      return asJsonp(callback, { ok: true, command: null });
    }
    return asJsonp(callback, { ok: true, command: current });
  }

  return asJsonp(callback, { ok: false, error: 'invalid mode' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    const mode = (body.mode || '').trim();

    if (!isAuthorized_(body.token || '')) {
      return asJson({ ok: false, error: 'unauthorized' });
    }

    if (mode === 'push_meta') {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(3000)) {
        return asJson({ ok: false, error: 'busy' });
      }

      try {
        if (body.sheetId) {
          const nextSheetId = normalizeSpreadsheetId_(body.sheetId);
          if (!isAllowedSpreadsheetId_(nextSheetId)) {
            return asJson({ ok: false, error: 'sheet id not allowed' });
          }
          PropertiesService.getScriptProperties().setProperty(KEY_SHEET_ID, nextSheetId);
        }
        const incomingMeta = body.meta && typeof body.meta === 'object' ? body.meta : {};
        const currentMeta = safeParseJson_(PropertiesService.getScriptProperties().getProperty(KEY_META), {});
        const currentScreens = currentMeta && currentMeta.screens && typeof currentMeta.screens === 'object'
          ? currentMeta.screens
          : {};
        const screenNumber = Math.max(1, Number(incomingMeta.wall && incomingMeta.wall.screen || 1));
        currentScreens[String(screenNumber)] = incomingMeta;
        incomingMeta.screens = currentScreens;
        PropertiesService.getScriptProperties().setProperty(KEY_META, JSON.stringify(incomingMeta));
        return asJson({ ok: true });
      } finally {
        lock.releaseLock();
      }
    }

    if (mode === 'push_command') {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(3000)) {
        return asJson({ ok: false, error: 'busy' });
      }

      try {
        const nextCommand = body.command || null;
        const properties = PropertiesService.getScriptProperties();
        const currentCommand = safeParseJson_(properties.getProperty(KEY_CMD), null);
        const history = safeParseJson_(properties.getProperty(KEY_CMD_HISTORY), []);

        // Retries from an older control device must never overwrite a newer
        // command that arrived after it. Command id is the retry identity.
        if (nextCommand && nextCommand.id && Array.isArray(history) && history.some(function(item) {
          return item && item.id === nextCommand.id;
        })) {
          return asJson({ ok: true, ignored: true, reason: 'duplicate command' });
        }

        if (!shouldStoreCommand_(currentCommand, nextCommand)) {
          return asJson({ ok: true, ignored: true, reason: 'duplicate or older command' });
        }

        properties.setProperty(KEY_CMD, JSON.stringify(nextCommand));
        appendCommandHistory_(properties, nextCommand);
        return asJson({ ok: true, ignored: false });
      } finally {
        lock.releaseLock();
      }
    }

    if (mode === 'set_sheet_id') {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(3000)) {
        return asJson({ ok: false, error: 'busy' });
      }

      try {
        const nextSheetId = normalizeSpreadsheetId_(body.sheetId);
        if (!isAllowedSpreadsheetId_(nextSheetId)) {
          return asJson({ ok: false, error: 'sheet id not allowed' });
        }
        PropertiesService.getScriptProperties().setProperty(KEY_SHEET_ID, nextSheetId);
        return asJson({ ok: true });
      } finally {
        lock.releaseLock();
      }
    }

    return asJson({ ok: false, error: 'invalid mode' });
  } catch (err) {
    return asJson({ ok: false, error: String(err) });
  }
}

function withLiveSheetPages_(meta, sheetId) {
  const liveNames = getLiveSheetPages_(sheetId);
  if (!liveNames.length) return meta;

  const nextMeta = meta && typeof meta === 'object' ? meta : {};
  const currentPages = Array.isArray(nextMeta.pages) ? nextMeta.pages : [];
  const currentByName = {};

  currentPages.forEach(function(page) {
    if (page && page.name) currentByName[normalizeName_(page.name)] = page;
  });

  nextMeta.pages = liveNames.map(function(name, index) {
    const existing = currentByName[normalizeName_(name)] || {};
    return {
      index: index,
      name: name,
      subCategories: Array.isArray(existing.subCategories) ? existing.subCategories : [],
      activeSubIndex: Number(existing.activeSubIndex || 0),
      productCount: Number(existing.productCount || 0)
    };
  });

  if (Number(nextMeta.currentPageIndex || 0) >= nextMeta.pages.length) {
    nextMeta.currentPageIndex = 0;
  }

  nextMeta.updatedAt = nextMeta.updatedAt || Date.now();
  nextMeta.currentPageIndex = Number(nextMeta.currentPageIndex || 0);
  nextMeta.currentMotherSubIndex = Number(nextMeta.currentMotherSubIndex || 0);
  nextMeta.currentSubPageIndex = Number(nextMeta.currentSubPageIndex || 0);
  nextMeta.viewCount = Number(nextMeta.viewCount || 0);
  nextMeta.totalSubPages = Number(nextMeta.totalSubPages || 1);
  nextMeta.autoPlay = nextMeta.autoPlay && typeof nextMeta.autoPlay === 'object'
    ? { enabled: nextMeta.autoPlay.enabled === true }
    : { enabled: false };
  nextMeta.wall = nextMeta.wall || { mode: 'single', enabled: false };

  return nextMeta;
}

function getLiveSheetPages_(sheetId) {
  const spreadsheetId = getSpreadsheetId_(sheetId);
  if (!spreadsheetId) return [];

  const cache = CacheService.getScriptCache();
  const cacheKey = 'pages:' + spreadsheetId;
  const cached = cache.get(cacheKey);
  if (cached) {
    const cachedPages = safeParseJson_(cached, null);
    if (Array.isArray(cachedPages)) return cachedPages;
  }

  try {
    const pages = SpreadsheetApp
      .openById(spreadsheetId)
      .getSheets()
      .map(function(sheet) { return sheet.getName(); })
      .filter(function(name) { return isDisplaySheetName_(name); });
    try {
      cache.put(cacheKey, JSON.stringify(pages), GAS_CACHE_TTL_SECONDS);
    } catch (cacheErr) {}
    return pages;
  } catch (err) {
    return [];
  }
}

function getSheetRows_(sheetId, sheetName) {
  const spreadsheetId = getSpreadsheetId_(sheetId);
  if (!spreadsheetId) return { ok: false, rows: [], error: 'missing spreadsheet id' };
  if (!sheetName) return { ok: false, rows: [], error: 'missing sheet name' };

  const cache = CacheService.getScriptCache();
  const cacheKey = 'rows:' + spreadsheetId + ':' + encodeURIComponent(sheetName);
  const cached = cache.get(cacheKey);
  if (cached) {
    const cachedRows = safeParseJson_(cached, null);
    if (Array.isArray(cachedRows)) return { ok: true, rows: cachedRows, error: '' };
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) return { ok: false, rows: [], error: 'sheet not found: ' + sheetName };

    const lastRow = sheet.getLastRow();
    if (!lastRow) return { ok: true, rows: [], error: '' };

    const maxCols = Math.min(Math.max(sheet.getLastColumn(), 1), 8);
    const result = {
      ok: true,
      rows: sheet.getRange(1, 1, lastRow, maxCols).getDisplayValues(),
      error: ''
    };
    try {
      cache.put(cacheKey, JSON.stringify(result.rows), GAS_CACHE_TTL_SECONDS);
    } catch (cacheErr) {}
    return result;
  } catch (err) {
    return { ok: false, rows: [], error: String(err) };
  }
}

function getSpreadsheetId_(sheetId) {
  const candidate = normalizeSpreadsheetId_(
    sheetId ||
    PropertiesService.getScriptProperties().getProperty(KEY_SHEET_ID) ||
    DEFAULT_SPREADSHEET_ID ||
    ''
  );

  return isAllowedSpreadsheetId_(candidate) ? candidate : '';
}

function normalizeSpreadsheetId_(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : raw;
}

function getRequestToken_(e) {
  return String((e && e.parameter && e.parameter.token) || '').trim();
}

function getConfiguredAuthToken_() {
  return String(PropertiesService.getScriptProperties().getProperty(KEY_AUTH_TOKEN) || '').trim();
}

function isAuthorized_(token) {
  const expected = getConfiguredAuthToken_();
  return !expected || String(token || '').trim() === expected;
}

function getAllowedSpreadsheetIds_() {
  const raw = String(PropertiesService.getScriptProperties().getProperty(KEY_ALLOWED_SHEET_IDS) || '').trim();
  const configured = raw
    ? raw.split(',').map(normalizeSpreadsheetId_).filter(Boolean)
    : [];

  const fallback = normalizeSpreadsheetId_(
    PropertiesService.getScriptProperties().getProperty(KEY_SHEET_ID) ||
    DEFAULT_SPREADSHEET_ID ||
    ''
  );

  if (fallback && configured.indexOf(fallback) === -1) configured.push(fallback);
  return configured;
}

function isAllowedSpreadsheetId_(sheetId) {
  const normalized = normalizeSpreadsheetId_(sheetId);
  return Boolean(normalized) && getAllowedSpreadsheetIds_().indexOf(normalized) !== -1;
}

function normalizeName_(value) {
  return String(value || '').trim().toLowerCase();
}

function safeParseJson_(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function getCommandCreatedAt_(command) {
  const createdAt = Number(command && (command.createdAt || command.sentAt || 0));
  return isFinite(createdAt) && createdAt > 0 ? createdAt : 0;
}

function shouldStoreCommand_(currentCommand, nextCommand) {
  if (!nextCommand || !nextCommand.action) return false;

  if (currentCommand && currentCommand.id && nextCommand.id && currentCommand.id === nextCommand.id) {
    return false;
  }
  // Arrival order on the server is authoritative. Client clocks can differ
  // across phones, PCs, and TVs, so createdAt must not reject a real click.
  return true;
}

function appendCommandHistory_(properties, command) {
  if (!command || !command.id) return;

  const history = safeParseJson_(
    properties.getProperty(KEY_CMD_HISTORY),
    []
  );
  const nextHistory = Array.isArray(history) ? history : [];

  if (!nextHistory.some(function(item) { return item && item.id === command.id; })) {
    nextHistory.push(command);
  }

  while (nextHistory.length > 30) nextHistory.shift();
  properties.setProperty(KEY_CMD_HISTORY, JSON.stringify(nextHistory));
}

function isDisplaySheetName_(name) {
  const normalized = normalizeName_(name);
  return Boolean(normalized) &&
    !/^_/.test(normalized) &&
    HIDDEN_SHEET_NAMES.indexOf(normalized) === -1;
}

function asJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function asJsonp(callback, obj) {
  const cb = callback || 'callback';
  const safeCb = cb.replace(/[^\w$.]/g, '');
  return ContentService
    .createTextOutput(`${safeCb}(${JSON.stringify(obj)});`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
