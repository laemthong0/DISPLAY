const KEY_META = 'TV_DISPLAY_META_V1';
const KEY_CMD = 'TV_DISPLAY_CMD_V1';
const KEY_SHEET_ID = 'TV_DISPLAY_SHEET_ID';
const KEY_AUTH_TOKEN = 'TV_DISPLAY_AUTH_TOKEN';
const KEY_ALLOWED_SHEET_IDS = 'TV_DISPLAY_ALLOWED_SHEET_IDS';
const DEFAULT_SPREADSHEET_ID = '166Ija7H3Dal4qA4ZokEJVEBXGY1BhW1DWb1pIXw_OgI';
const HIDDEN_SHEET_NAMES = ['price'];

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
    return asJsonp(callback, { ok: true, meta: withLiveSheetPages_(meta, sheetId) });
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
    const cmdRaw = PropertiesService.getScriptProperties().getProperty(KEY_CMD);
    const cmd = safeParseJson_(cmdRaw, null);

    if (!cmd || !cmd.id || cmd.id === lastId) {
      return asJsonp(callback, { ok: true, command: null });
    }
    return asJsonp(callback, { ok: true, command: cmd });
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
      if (body.sheetId) {
        const nextSheetId = normalizeSpreadsheetId_(body.sheetId);
        if (!isAllowedSpreadsheetId_(nextSheetId)) {
          return asJson({ ok: false, error: 'sheet id not allowed' });
        }
        PropertiesService.getScriptProperties().setProperty(KEY_SHEET_ID, nextSheetId);
      }
      PropertiesService.getScriptProperties().setProperty(KEY_META, JSON.stringify(body.meta || null));
      return asJson({ ok: true });
    }

    if (mode === 'push_command') {
      const nextCommand = body.command || null;
      const currentCommand = safeParseJson_(PropertiesService.getScriptProperties().getProperty(KEY_CMD), null);

      if (!shouldStoreCommand_(currentCommand, nextCommand)) {
        return asJson({ ok: true, ignored: true, reason: 'older command' });
      }

      PropertiesService.getScriptProperties().setProperty(KEY_CMD, JSON.stringify(nextCommand));
      return asJson({ ok: true, ignored: false });
    }

    if (mode === 'set_sheet_id') {
      const nextSheetId = normalizeSpreadsheetId_(body.sheetId);
      if (!isAllowedSpreadsheetId_(nextSheetId)) {
        return asJson({ ok: false, error: 'sheet id not allowed' });
      }
      PropertiesService.getScriptProperties().setProperty(KEY_SHEET_ID, nextSheetId);
      return asJson({ ok: true });
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

  try {
    return SpreadsheetApp
      .openById(spreadsheetId)
      .getSheets()
      .map(function(sheet) { return sheet.getName(); })
      .filter(function(name) { return isDisplaySheetName_(name); });
  } catch (err) {
    return [];
  }
}

function getSheetRows_(sheetId, sheetName) {
  const spreadsheetId = getSpreadsheetId_(sheetId);
  if (!spreadsheetId) return { ok: false, rows: [], error: 'missing spreadsheet id' };
  if (!sheetName) return { ok: false, rows: [], error: 'missing sheet name' };

  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) return { ok: false, rows: [], error: 'sheet not found: ' + sheetName };

    const lastRow = sheet.getLastRow();
    if (!lastRow) return { ok: true, rows: [], error: '' };

    const maxCols = Math.min(Math.max(sheet.getLastColumn(), 1), 8);
    return {
      ok: true,
      rows: sheet.getRange(1, 1, lastRow, maxCols).getDisplayValues(),
      error: ''
    };
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
  return String(value || '').trim();
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
  if (!nextCommand) return true;

  const currentCreatedAt = getCommandCreatedAt_(currentCommand);
  const nextCreatedAt = getCommandCreatedAt_(nextCommand);

  if (currentCreatedAt && nextCreatedAt && nextCreatedAt < currentCreatedAt) {
    return false;
  }

  return true;
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
