'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, Menu, nativeTheme, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store, ResultCache } = require('./store.cjs');
const { TYPES, makeDriver, detectLocal, parseUrl } = require('./drivers/index.cjs');
const { buildSelect, buildCount, buildDistinct, buildDistinctWrapped, wrapQuery, buildEdits, editsText } = require('./drivers/sqlbuild.cjs');
const { runTransfer } = require('./transfer.cjs');
const { statementKind, codeWords } = require('./lib/sqltext.cjs');
const { runDump, toolsStatus } = require('./dump.cjs');
const { McpServer } = require('./mcp.cjs');

process.removeAllListeners('warning'); // node:sqlite's "experimental" notice
app.setName('Pelican');
// Test hooks: a throwaway data dir and a scripted run (screenshots, smoke tests). Ignored in normal use.
if (process.env.PELICAN_USER_DATA) app.setPath('userData', process.env.PELICAN_USER_DATA);
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([{ scheme: 'pelican', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let store;
const cache = new ResultCache();
const meta = new Map(); // metadata cache: key → value
let win = null;

// ---------------- connections ----------------
const live = new Map(); // id → { cfg, driver, version, opening }
const cfgOf = (id) => {
  const c = store.connections.find((x) => x.id === id);
  if (!c) throw new Error('Connection not found');
  return c;
};
async function open(id) {
  let l = live.get(id);
  if (l?.driver && l.ready) return l;
  if (l?.opening) return l.opening;
  const cfg = cfgOf(id);
  l = { cfg, driver: makeDriver(cfg) };
  live.set(id, l);
  l.opening = (async () => {
    try {
      const info = await l.driver.connect();
      l.version = info.version;
      l.ready = true;
      notify('conn:state', { id, state: 'connected', version: l.version });
      return l;
    } catch (e) {
      live.delete(id);
      await l.driver.close().catch(() => {});
      notify('conn:state', { id, state: 'error', error: e.message });
      throw e;
    } finally { l.opening = null; }
  })();
  return l.opening;
}
async function closeConn(id) {
  const l = live.get(id);
  live.delete(id);
  for (const k of [...meta.keys()]) if (k.startsWith(id + '\u0000')) meta.delete(k);
  cache.invalidate(id);
  if (l) await l.driver.close().catch(() => {});
  notify('conn:state', { id, state: 'closed' });
}
function notify(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }

async function cachedMeta(id, parts, refresh, fn) {
  const key = [id, ...parts].join('\u0000');
  if (!refresh && meta.has(key)) return meta.get(key);
  const v = await fn((await open(id)).driver);
  meta.set(key, v);
  return v;
}
const ttl = () => (store.config.settings.cacheTtlMin > 0 ? store.config.settings.cacheTtlMin * 60000 : 0);
const useCache = (refresh) => store.config.settings.cache && !refresh;

function logHistory(h) {
  const c = store.connections.find((x) => x.id === h.connId);
  const e = store.addHistory({ ...h, connName: c?.name || '', connType: c?.type || '' });
  notify('history:add', e);
}

// ---------------- MCP ----------------
let mcp;
const activity = [];
async function startMcp() {
  if (mcp?.running) await mcp.stop();
  mcp = new McpServer({
    config: () => ({ mcp: store.config.mcp, connections: store.connections }),
    open,
    log: (h) => logHistory({ ...h, type: 'mcp', result: h.ok ? 'ok' : h.error }),
    activity: (e) => {
      activity.push(e);
      if (activity.length > 500) activity.shift();
      notify('mcp:activity', e);
      if (!e.ok) logHistory({ connId: store.connections.find((c) => c.name === e.connection)?.id, sql: e.sql || e.tool, type: 'mcp', result: e.error, ms: e.ms });
    },
    confirm: async ({ connection, sql }) => {
      if (win?.isMinimized()) win.restore();
      win?.show();
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1,
        message: `An AI client wants to change data on “${connection}”`,
        detail: sql.length > 1500 ? sql.slice(0, 1500) + '…' : sql,
      });
      return r.response === 0;
    },
  });
  if (store.config.mcp.enabled) {
    try { await mcp.start(); } catch (e) { store.config.mcp.enabled = false; store.saveConfig(); notify('mcp:error', e.code === 'EADDRINUSE' ? `Port ${store.config.mcp.port} is in use. Pick another port.` : e.message); }
  }
}
function mcpState() {
  const m = store.config.mcp;
  return { ...m, running: !!mcp?.running, url: `http://127.0.0.1:${m.port}/mcp` };
}

// ---------------- data helpers ----------------
function filterDocMongo(driver, where, filters) {
  const and = [];
  const f = driver.parseFilter(where);
  if (Object.keys(f).length) and.push(f);
  and.push(...driver.filterDoc(filters));
  return and.length ? { $and: and } : {};
}

async function tableData(o) {
  const l = await open(o.connId);
  const d = l.driver;
  const key = cache.key(['table', o.connId, o.db, o.schema, o.table, o.where || '', o.filters || [], o.order || [], o.limit, o.offset || 0]);
  if (useCache(o.refresh)) {
    const hit = cache.get(key, ttl());
    if (hit) return { ...hit.value, cached: { at: hit.at } };
  }
  const t0 = performance.now();
  let result; let sql;
  try {
    if (d.dialect === 'mongo') {
      const filter = filterDocMongo(d, o.where, o.filters);
      const sort = Object.fromEntries((o.order || []).map((s) => [s.col, s.dir === 'desc' ? -1 : 1]));
      sql = `db.getCollection(${JSON.stringify(o.table)}).find(${JSON.stringify(filter)})${Object.keys(sort).length ? `.sort(${JSON.stringify(sort)})` : ''}.skip(${o.offset || 0}).limit(${o.limit})`;
      result = await d.find(o.schema, o.table, { filter, sort, limit: o.limit, offset: o.offset || 0 });
    } else {
      const q = buildSelect({ dialect: d.dialect, schema: o.schema, table: o.table, where: o.where, filters: o.filters, order: o.order, limit: o.limit + 1, offset: o.offset });
      sql = q.sql;
      result = await d.query(o.db, q.sql, q.params, { maxRows: o.limit });
    }
  } catch (e) {
    logHistory({ connId: o.connId, sql: sql || o.table, type: 'table', result: e.message, ms: Math.round(performance.now() - t0) });
    throw e;
  }
  const ms = Math.round(performance.now() - t0);
  logHistory({ connId: o.connId, sql, type: 'table', result: 'ok', rows: result.rows.length, ms });
  const value = { result, ms, sql };
  if (store.config.settings.cache) cache.set(key, o.connId, value);
  return { ...value, cached: null };
}

async function runQuery(o) {
  const l = await open(o.connId);
  const d = l.driver;
  const s = store.config.settings;
  const maxRows = o.maxRows || s.editorMaxRows || 1000;
  let sql = o.sql;
  let params = [];
  if (o.wrap && d.dialect !== 'mongo' && (o.wrap.where || o.wrap.filters?.length || o.wrap.order?.length)) {
    const w = wrapQuery({ dialect: d.dialect, sql: o.sql, where: o.wrap.where, filters: o.wrap.filters, order: o.wrap.order, limit: maxRows + 1 });
    sql = w.sql; params = w.params;
  }
  const kind = d.dialect === 'mongo' ? (d.inspect(o.sql, o.schema || d.defaultDb()).writes ? 'write' : 'read') : statementKind(sql, d.dialect);
  const key = cache.key(['query', o.connId, o.db, o.schema, sql, params, maxRows]);
  if (kind === 'read' && useCache(o.refresh)) {
    const hit = cache.get(key, ttl());
    if (hit) return { ...hit.value, cached: { at: hit.at } };
  }
  const t0 = performance.now();
  let result;
  try {
    result = await d.query(o.db, sql, params, { maxRows, session: o.session, runId: o.runId, schema: o.schema });
  } catch (e) {
    logHistory({ connId: o.connId, sql: o.sql, type: 'user', result: e.message, ms: Math.round(performance.now() - t0), db: o.db, schema: o.schema });
    throw e;
  }
  const ms = Math.round(performance.now() - t0);
  logHistory({ connId: o.connId, sql: o.sql, type: 'user', result: 'ok', rows: result.affected ?? result.rows.length, ms, db: o.db, schema: o.schema });
  const value = { result, ms, sql };
  if (kind === 'read' && s.cache) cache.set(key, o.connId, value);
  if (kind === 'write') {
    cache.invalidate(o.connId); // a change makes every cached read of this connection stale
    const w = d.dialect === 'mongo' ? '' : codeWords(o.sql, d.dialect)[0];
    if (['create', 'drop', 'alter', 'rename', 'truncate'].includes(w) || d.dialect === 'mongo') for (const k of [...meta.keys()]) if (k.startsWith(o.connId + '\u0000')) meta.delete(k);
  }
  return { ...value, cached: null, kind };
}

// ---------------- IPC ----------------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
}
function registerIpc() {
  handle('app:state', () => ({
    connections: store.connections, settings: store.config.settings, mcp: mcpState(), types: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { label: v.label, port: v.port, user: v.user, database: v.database }])),
    live: [...live].filter(([, l]) => l.ready).map(([id, l]) => ({ id, version: l.version })), version: app.getVersion(), layout: store.config.layout || {},
    scripts: store.loadScripts(), activity, home: app.getPath('home'), downloads: store.config.lastDumpDir || app.getPath('downloads'),
  }));
  handle('settings:set', (patch) => {
    Object.assign(store.config.settings, patch);
    if ('cache' in patch && !patch.cache) cache.invalidate();
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    store.saveConfig();
    return store.config.settings;
  });
  handle('layout:set', (patch) => { store.config.layout = { ...(store.config.layout || {}), ...patch }; store.saveConfig(); });

  handle('conn:save', async (c) => {
    const saved = store.upsertConnection(c);
    if (live.has(saved.id)) await closeConn(saved.id);
    return saved;
  });
  handle('conn:remove', async (id) => { await closeConn(id); store.removeConnection(id); });
  handle('conn:test', async (cfg) => {
    const d = makeDriver(cfg);
    const t0 = performance.now();
    try { const info = await d.connect(); return { version: info.version, ms: Math.round(performance.now() - t0) }; } finally { await d.close().catch(() => {}); }
  });
  handle('conn:connect', async (id) => { const l = await open(id); return { version: l.version }; });
  handle('conn:disconnect', (id) => closeConn(id));
  handle('conn:detect', () => detectLocal());
  handle('conn:parseUrl', (t) => parseUrl(t));
  handle('conn:pickFile', async ({ create } = {}) => {
    const r = create
      ? await dialog.showSaveDialog(win, { title: 'New SQLite database', defaultPath: 'database.sqlite', filters: [{ name: 'SQLite', extensions: ['sqlite', 'db', 'sqlite3'] }] })
      : await dialog.showOpenDialog(win, { title: 'Open SQLite database', properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['sqlite', 'db', 'sqlite3', 'db3'] }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? null : r.filePath || r.filePaths[0];
  });

  handle('meta:databases', (id, refresh) => cachedMeta(id, ['dbs'], refresh, (d) => d.databases()));
  handle('meta:schemas', (id, db, refresh) => cachedMeta(id, ['schemas', db, store.config.settings.showSystem], refresh, (d) => d.schemas(db, { system: store.config.settings.showSystem })));
  handle('meta:objects', (id, db, schema, refresh) => cachedMeta(id, ['objects', db, schema], refresh, (d) => d.objects(db, schema)));
  handle('meta:columns', (id, db, schema, table, refresh) => cachedMeta(id, ['columns', db, schema, table], refresh, (d) => d.columns(db, schema, table)));
  handle('meta:table', (id, db, schema, table, refresh) => cachedMeta(id, ['table', db, schema, table], refresh, async (d) => {
    const [columns, indexes, fks, ddl, partitions] = await Promise.all([d.columns(db, schema, table), d.indexes(db, schema, table).catch(() => []), d.foreignKeys(db, schema, table).catch(() => []), d.ddl(db, schema, table).catch((e) => `-- ${e.message}`), d.partitions ? d.partitions(db, schema, table).catch(() => null) : null]);
    return { columns, indexes, fks, ddl, partitions };
  }));
  handle('meta:partitions', (id, db, schema, table, refresh) => cachedMeta(id, ['partitions', db, schema, table], refresh, (d) => (d.partitions ? d.partitions(db, schema, table) : null)));
  handle('meta:info', (id) => { const l = live.get(id); return l ? { version: l.version, dialect: l.driver.dialect } : null; });

  handle('data:table', (o) => tableData(o));
  handle('data:count', async (o) => {
    const d = (await open(o.connId)).driver;
    if (d.dialect === 'mongo') return d.count(o.schema, o.table, filterDocMongo(d, o.where, o.filters));
    const q = buildCount({ dialect: d.dialect, ...o });
    const r = await d.query(o.db, q.sql, q.params, { maxRows: 1 });
    return +r.rows[0][0];
  });
  handle('data:distinct', async (o) => {
    const d = (await open(o.connId)).driver;
    if (d.dialect === 'mongo') return d.distinctCounts(o.schema, o.table, o.col, filterDocMongo(d, o.where, (o.filters || []).filter((f) => f.col !== o.col)));
    const q = o.sql ? buildDistinctWrapped({ dialect: d.dialect, ...o }) : buildDistinct({ dialect: d.dialect, ...o });
    const r = await d.query(o.db, q.sql, q.params, { maxRows: 300, schema: o.sql ? o.schema : undefined });
    return r.rows.map(([v, n]) => ({ v, n: +n }));
  });
  handle('data:query', (o) => runQuery(o));
  handle('data:explain', async (o) => {
    const d = (await open(o.connId)).driver;
    const t0 = performance.now();
    const r = await d.explain(o.db, o.sql, { analyze: !!o.analyze, schema: o.schema });
    logHistory({ connId: o.connId, sql: (o.analyze ? 'EXPLAIN ANALYZE ' : 'EXPLAIN ') + o.sql, type: 'user', result: 'ok', ms: Math.round(performance.now() - t0) });
    return r;
  });
  handle('data:previewEdits', async (o) => {
    const d = (await open(o.connId)).driver;
    return d.dialect === 'mongo' ? d.editsText(o.table, o.changes) : editsText({ dialect: d.dialect, schema: o.schema, table: o.table, changes: o.changes });
  });
  handle('data:applyEdits', async (o) => {
    const l = await open(o.connId);
    const d = l.driver;
    if (l.cfg.readOnly) throw new Error('This connection is read-only.');
    const t0 = performance.now();
    const text = d.dialect === 'mongo' ? d.editsText(o.table, o.changes) : editsText({ dialect: d.dialect, schema: o.schema, table: o.table, changes: o.changes });
    try {
      if (d.dialect === 'mongo') await d.applyEdits(o.schema, o.table, o.changes);
      else await d.tx(o.db, buildEdits({ dialect: d.dialect, schema: o.schema, table: o.table, changes: o.changes }));
    } catch (e) {
      logHistory({ connId: o.connId, sql: text, type: 'user', result: e.message, ms: Math.round(performance.now() - t0), db: o.db, schema: o.schema });
      throw e;
    } finally { cache.invalidate(o.connId); }
    logHistory({ connId: o.connId, sql: text, type: 'user', result: 'ok', rows: o.changes.length, ms: Math.round(performance.now() - t0), db: o.db, schema: o.schema });
    for (const k of [...meta.keys()]) if (k.startsWith(o.connId + '\u0000objects')) meta.delete(k); // row counts
    return { saved: o.changes.length };
  });
  handle('data:cancel', async (connId, runId) => { const l = live.get(connId); if (l) await l.driver.cancel?.(runId); });
  handle('data:endSession', (connId, session) => { live.get(connId)?.driver.endSession?.(session); });
  handle('cache:clear', (connId) => { cache.invalidate(connId); return cache.stats(); });
  handle('cache:stats', () => cache.stats());

  handle('history:list', () => store.history.slice(-2000));
  handle('history:clear', () => store.clearHistory());

  handle('scripts:save', (s) => store.saveScript(s));
  handle('scripts:tabs', (list) => store.saveScriptTabs(list));
  handle('scripts:delete', (id) => store.deleteScript(id));

  handle('dump:tools', () => toolsStatus());
  handle('dump:pickOut', async (name) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save dump', defaultPath: path.join(store.config.lastDumpDir || app.getPath('downloads'), name) });
    if (r.canceled) return null;
    store.config.lastDumpDir = path.dirname(r.filePath);
    store.saveConfig();
    return r.filePath;
  });
  let dumpAbort = null;
  handle('dump:run', async (o) => {
    if (dumpAbort) throw new Error('A dump is already running.');
    const l = await open(o.connId);
    dumpAbort = new AbortController();
    try {
      return await runDump({ cfg: l.cfg, driver: l.driver }, o, (evt) => notify('dump:progress', evt), dumpAbort.signal);
    } finally { dumpAbort = null; }
  });
  handle('dump:cancel', () => dumpAbort?.abort());

  let transferAbort = null;
  handle('transfer:run', async (o) => {
    if (transferAbort) throw new Error('A transfer is already running.');
    const [s, t] = [await open(o.from), await open(o.to)];
    if (t.cfg.readOnly) throw new Error(`“${t.cfg.name}” is opened read-only.`);
    transferAbort = new AbortController();
    try {
      return await runTransfer({ src: { id: o.from, ...s }, dst: { id: o.to, ...t }, o, progress: (e) => notify('transfer:progress', e), signal: transferAbort.signal });
    } finally {
      transferAbort = null;
      cache.invalidate(o.to);
      for (const k of [...meta.keys()]) if (k.startsWith(o.to + '\u0000')) meta.delete(k);
    }
  });
  handle('transfer:cancel', () => transferAbort?.abort());

  handle('mcp:state', () => mcpState());
  handle('mcp:set', async (patch) => {
    const m = store.config.mcp;
    const restart = ('enabled' in patch && patch.enabled !== m.enabled) || ('port' in patch && +patch.port !== m.port);
    if (patch.policy) { m.policies[patch.policy.id] = { ...(m.policies[patch.policy.id] || {}), ...patch.policy.value }; delete patch.policy; }
    if (patch.regenerateToken) { m.token = require('crypto').randomBytes(18).toString('base64url'); delete patch.regenerateToken; }
    Object.assign(m, patch);
    if ('port' in patch) m.port = Math.max(1024, Math.min(65535, +patch.port || 7429));
    store.saveConfig();
    if (restart) await startMcp();
    return mcpState();
  });
  handle('mcp:activity', () => activity);

  handle('file:save', async ({ name, content, filters }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name), filters });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, content);
    return r.filePath;
  });
  handle('shell:reveal', (p) => shell.showItemInFolder(p));
  handle('shell:open', (url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
  handle('clipboard:write', (t) => clipboard.writeText(String(t)));
}

// ---------------- window ----------------
function createWindow() {
  const b = store.config.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y, minWidth: 980, minHeight: 600,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 },
    ...(process.env.PELICAN_SCRIPT ? { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f4f4f6' } : { vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  const remember = () => { if (!win.isMinimized() && !win.isFullScreen()) { store.config.bounds = win.getBounds(); store.saveConfig(); } };
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    const ok = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('pelican://app/');
    if (!ok) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('pelican://app/index.html');
  if (process.env.PELICAN_SCRIPT) win.webContents.once('did-finish-load', () => runScript(process.env.PELICAN_SCRIPT));
}

async function runScript(file) {
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (e) => { console.log('[renderer]', e.level, e.message, e.sourceId ? e.sourceId.split('/').pop() + ':' + e.lineNumber : ''); });
  await wait(1200);
  for (const st of steps) {
    try {
      if (st.size) win.setContentSize(st.size[0], st.size[1]);
      if (st.theme) nativeTheme.themeSource = st.theme;
      if (st.main) { const r = await eval(`(async () => { ${st.main} })()`); if (r !== undefined) console.log('[main]', JSON.stringify(r)); }
      if (st.eval) { const r = await win.webContents.executeJavaScript(st.eval, true); if (r !== undefined) console.log('[eval]', JSON.stringify(r)); }
      if (st.key) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: st.key, modifiers: st.mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: st.key, modifiers: st.mods || [] }); }
      if (st.type) for (const ch of st.type) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      await wait(st.wait ?? 400);
      if (st.shot) fs.writeFileSync(st.shot, (await win.webContents.capturePage()).toPNG());
    } catch (e) { console.log('[step error]', e.message); }
  }
  app.exit(0);
}

function send(cmd, arg) { win?.webContents.send('menu', cmd, arg); }
function buildMenu() {
  const t = [
    { label: 'Pelican', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
      { label: 'AI Access (MCP)…', accelerator: 'Cmd+Shift+M', click: () => send('mcp') },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'New Connection…', accelerator: 'Cmd+N', click: () => send('new-connection') },
      { label: 'New SQL Editor', accelerator: 'Cmd+T', click: () => send('new-editor') },
      { type: 'separator' },
      { label: 'Dump…', accelerator: 'Cmd+Shift+D', click: () => send('dump') },
      { label: 'Transfer to Another Database…', accelerator: 'Cmd+Shift+T', click: () => send('transfer') },
      { type: 'separator' },
      { label: 'Save Changes', accelerator: 'Cmd+S', click: () => send('save') },
      { label: 'Close Tab', accelerator: 'Cmd+W', click: () => send('close-tab') }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Find…', accelerator: 'Cmd+F', click: () => send('find') }] },
    { label: 'Query', submenu: [
      { label: 'Run Statement', accelerator: 'Cmd+Enter', click: () => send('run') },
      { label: 'Run Script', accelerator: 'Cmd+Shift+Enter', click: () => send('run-script') },
      { label: 'Explain Plan', accelerator: 'Cmd+E', click: () => send('explain') },
      { label: 'Explain Analyze', accelerator: 'Cmd+Shift+E', click: () => send('explain-analyze') },
      { label: 'Cancel', accelerator: 'Cmd+.', click: () => send('cancel') },
      { type: 'separator' },
      { label: 'Refresh (skip cache)', accelerator: 'Cmd+R', click: () => send('refresh') },
      { label: 'Use Cached Results', type: 'checkbox', checked: !!store.config.settings.cache, click: (m) => send('cache', m.checked) }] },
    { label: 'View', submenu: [
      { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => send('toggle-sidebar') },
      { label: 'Query Manager', accelerator: 'Cmd+J', click: () => send('toggle-history') },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => send('next-tab') },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => send('prev-tab') },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      { label: 'Developer Tools', accelerator: 'Alt+Cmd+I', click: () => win?.webContents.toggleDevTools() }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Pelican on GitHub', click: () => shell.openExternal('https://github.com/pucksaeroi-beep/pelican') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  if (store.config.settings.theme && store.config.settings.theme !== 'system') nativeTheme.themeSource = store.config.settings.theme;
  protocol.handle('pelican', (req) => {
    const u = new URL(req.url);
    const p = path.normalize(path.join(DIST, decodeURIComponent(u.pathname)));
    if (!p.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  registerIpc();
  buildMenu();
  createWindow();
  await startMcp();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { mcp?.stop(); for (const l of live.values()) l.driver.close().catch(() => {}); });
