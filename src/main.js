import './styles/app.css';
import { h, icon, clear, uid, dragger, $ } from './ui/h.js';
import { contextMenu, toast, closeMenus } from './ui/overlay.js';
import { app, api } from './app.js';
import { Sidebar, engineBadge } from './views/sidebar.js';
import { TableView } from './views/table.js';
import { EditorView } from './views/editor.js';
import { HistoryPanel } from './views/history.js';
import { connectionDialog } from './dialogs/connection.js';
import { dumpDialog } from './dialogs/dump.js';
import { mcpDialog } from './dialogs/mcp.js';
import { settingsDialog } from './dialogs/settings.js';
import { ENGINES } from './ui/icons.js';

const tabs = [];
let active = null;
let sidebar; let history; let tabbar; let content; let dock; let status; let shell;

async function boot() {
  const s = await api.app.state();
  Object.assign(app.state, { connections: s.connections, settings: s.settings, mcp: s.mcp, types: s.types, version: s.version, layout: s.layout || {}, home: s.home, dumpDir: s.downloads });
  for (const l of s.live) app.state.live.set(l.id, l.version);
  applyTheme();

  sidebar = new Sidebar();
  history = new HistoryPanel();
  tabbar = h('div', { class: 'tabbar drag' });
  content = h('div', { class: 'content' });
  status = h('footer', { class: 'statusbar' });
  dock = h('div', { class: 'dock-wrap' }, h('div', { class: 'vsplit' }), history.el);
  const sbResize = h('div', { class: 'sb-resize' });
  const main = h('main', { class: 'main' }, tabbar, content, dock, status);
  shell = h('div', { class: 'app' + (app.state.layout.sidebarHidden ? ' no-sidebar' : '') + (app.state.layout.dockOpen ? '' : ' no-dock') }, sidebar.el, sbResize, main);
  document.body.append(shell);
  document.documentElement.style.setProperty('--sb-w', (app.state.layout.sidebarW || 280) + 'px');
  document.documentElement.style.setProperty('--dock-h', (app.state.layout.dockH || 220) + 'px');
  dragger(sbResize, { onStart: () => sidebar.el.offsetWidth, onMove: (d, w0) => document.documentElement.style.setProperty('--sb-w', Math.max(200, Math.min(560, w0 + d)) + 'px'), onEnd: () => api.layout.set({ sidebarW: sidebar.el.offsetWidth }) });
  dragger(dock.firstChild, { axis: 'y', onStart: () => dock.offsetHeight, onMove: (d, h0) => document.documentElement.style.setProperty('--dock-h', Math.max(100, Math.min(window.innerHeight - 220, h0 - d)) + 'px'), onEnd: () => api.layout.set({ dockH: dock.offsetHeight }) });

  // editor tabs come back where they were
  for (const sc of s.scripts || []) if (!sc.connId || app.conn(sc.connId)) openTab(new EditorView({ ...sc, text: sc.text }), { activate: false, persist: false });
  if (tabs.length) activate(tabs[tabs.length - 1]);
  else showWelcome();
  drawStatus();
  wire();
  requestAnimationFrame(() => document.body.classList.add('ready'));
}

function applyTheme() {
  const t = app.state.settings.theme;
  document.documentElement.dataset.theme = t === 'light' || t === 'dark' ? t : '';
  document.documentElement.style.setProperty('--code-size', (app.state.settings.fontSize || 13) + 'px');
}

// ---------------- tabs ----------------
function openTab(view, { activate: act = true, persist = true } = {}) {
  const k = view.key();
  const existing = tabs.find((t) => t.view.key() === k);
  if (existing) { view.destroy?.(); if (act) activate(existing); return existing.view; }
  const t = { id: uid('t'), view };
  tabs.push(t);
  view.el.style.display = 'none';
  content.append(view.el);
  $('.welcome', content)?.remove();
  if (act) activate(t); else drawTabs();
  if (persist) persistTabs();
  return view;
}
function activate(t) {
  active = t;
  for (const x of tabs) x.view.el.style.display = x === t ? '' : 'none';
  drawTabs();
  drawStatus();
  setTimeout(() => t.view.focus?.(), 0);
}
function closeTab(t) {
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  t.view.el.remove();
  t.view.destroy?.();
  if (t.view instanceof EditorView) api.scripts.delete(t.view.id);
  if (active === t) { const n = tabs[Math.min(i, tabs.length - 1)]; if (n) activate(n); else { active = null; showWelcome(); } }
  drawTabs();
  persistTabs();
}
function persistTabs() { api.scripts.tabs(tabs.filter((t) => t.view instanceof EditorView).map((t) => t.view.meta())); }
function drawTabs() {
  clear(tabbar);
  tabbar.append(h('div', { class: 'tabs-scroll' }, tabs.map((t) => {
    const v = t.view;
    const c = app.conn(v.addr?.connId || v.connId);
    const el = h('div', { class: 'tab' + (t === active ? ' on' : ''), title: v.addr ? `${c?.name} · ${v.addr.schema || ''}.${v.addr.table}` : `${v.title}${c ? ' · ' + c.name : ''}` },
      c?.color ? h('span', { class: 'tab-color', style: { background: c.color } }) : null,
      icon(v.iconName, 'tab-ic ' + v.iconName), h('span', { class: 'tab-t' }, v.addr ? v.title : `${c ? c.name : 'Script'}`), v instanceof EditorView ? h('span', { class: 'tab-sub' }, v.schema || '') : null,
      h('button', { class: 'tab-x', title: 'Close (⌘W)', onclick: (e) => { e.stopPropagation(); closeTab(t); } }, icon('x')));
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } else if (e.button === 0 && !e.target.closest('.tab-x')) activate(t); });
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Close', kbd: '⌘W', onClick: () => closeTab(t) },
      { label: 'Close others', onClick: () => [...tabs].filter((x) => x !== t).forEach(closeTab) },
      { label: 'Close all', onClick: () => [...tabs].forEach(closeTab) },
    ]));
    return el;
  })), h('button', { class: 'icon-btn tab-new', title: 'New SQL editor (⌘T)', onclick: () => newEditor() }, icon('plus')), h('span', { class: 'grow' }));
  tabbar.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function newEditor(o = {}) {
  const cur = active?.view;
  const connId = o.connId || cur?.addr?.connId || cur?.connId || app.state.connections[0]?.id;
  const v = new EditorView({ connId, db: o.db ?? (cur?.addr?.connId === connId ? cur.addr.db : cur?.connId === connId ? cur.db : null), schema: o.schema ?? (cur?.addr?.connId === connId ? cur.addr.schema : cur?.connId === connId ? cur.schema : null), text: o.text || '', run: o.run });
  openTab(v);
  if (o.text) api.scripts.save({ id: v.id, text: o.text });
  return v;
}

// ---------------- welcome ----------------
function showWelcome() {
  if ($('.welcome', content)) return;
  const found = h('div', { class: 'w-found' });
  const el = h('div', { class: 'welcome' },
    h('div', { class: 'w-hero' }, h('img', { src: './logo.svg', class: 'w-logo', alt: '' }), h('div', {}, h('h1', {}, 'Pelican'), h('div', { class: 'muted' }, 'PostgreSQL · MySQL · SQLite · MongoDB · Db2'))),
    h('div', { class: 'w-actions' },
      h('button', { class: 'w-act', onclick: () => connectionDialog() }, icon('plus'), h('b', {}, 'New connection'), h('span', { class: 'muted' }, '⌘N')),
      h('button', { class: 'w-act', onclick: () => newEditor() }, icon('code'), h('b', {}, 'SQL editor'), h('span', { class: 'muted' }, '⌘T')),
      h('button', { class: 'w-act', onclick: () => dumpDialog() }, icon('download'), h('b', {}, 'Dump'), h('span', { class: 'muted' }, '⇧⌘D')),
      h('button', { class: 'w-act', onclick: () => mcpDialog() }, icon('sparkles'), h('b', {}, 'AI access (MCP)'), h('span', { class: 'muted' }, '⇧⌘M'))),
    found,
    h('div', { class: 'w-keys' }, [['⌘↵', 'Run statement'], ['⇧⌘↵', 'Run script'], ['⌘E', 'Explain plan'], ['⌘R', 'Refresh, skip cache'], ['⌘J', 'Query Manager'], ['⌘B', 'Sidebar']].map(([k, l]) => h('div', {}, h('kbd', {}, k), h('span', {}, l)))));
  content.append(el);
  api.conn.detect().then((list) => {
    const fresh = list.filter((f) => !app.state.connections.some((c) => c.type === f.type && +c.port === f.port));
    if (!fresh.length) return;
    found.append(h('div', { class: 'w-sub' }, 'Found on this Mac'), fresh.map((f) => h('button', { class: 'found-item', onclick: () => connectionDialog({ type: f.type, host: 'localhost', port: f.port, user: app.state.types[f.type]?.user, database: app.state.types[f.type]?.database, name: '' }) },
      engineBadge(f.type), h('span', {}, ENGINES[f.type].name), h('span', { class: 'muted mono' }, `localhost:${f.port}`), h('span', { class: 'grow' }), h('span', { class: 'link' }, 'Connect'))));
  }).catch(() => {});
}

// ---------------- status bar ----------------
function drawStatus() {
  clear(status);
  const v = active?.view;
  const c = app.conn(v?.addr?.connId || v?.connId);
  const m = app.state.mcp;
  const shared = app.state.connections.filter((x) => (m.policies?.[x.id]?.access || 'off') !== 'off').length;
  status.append(
    c ? h('span', { class: 'sb-item' }, engineBadge(c.type, 'xs'), h('span', {}, c.name), app.state.live.get(c.id) ? h('span', { class: 'muted' }, app.state.live.get(c.id)) : h('span', { class: 'muted' }, 'not connected')) : h('span', { class: 'sb-item muted' }, 'Pelican'),
    h('span', { class: 'grow' }),
    h('button', { class: 'sb-item sb-btn' + (app.state.settings.cache ? ' on' : ''), title: app.state.settings.cache ? 'Cached results are on — reopening a table or re-running a read uses rows already fetched. Click to turn off.' : 'Cache is off — every view fetches from the database. Click to turn on.', onclick: () => toggleCache() }, icon('zap'), app.state.settings.cache ? 'Cache on' : 'Cache off'),
    h('button', { class: 'sb-item sb-btn' + (m.enabled && m.running ? ' on ai' : ''), title: 'AI access (MCP)', onclick: () => mcpDialog() }, icon('sparkles'), m.enabled && m.running ? `AI · ${shared} shared` : 'AI off'),
    h('button', { class: 'sb-item sb-btn' + (shell?.classList.contains('no-dock') ? '' : ' on'), title: 'Query Manager (⌘J)', onclick: () => toggleDock() }, icon('history'), 'Query Manager'));
}
async function toggleCache(force) {
  const on = force ?? !app.state.settings.cache;
  await app.setSettings({ cache: on });
  toast(on ? 'Cache on — views reuse rows already fetched (⌘R fetches fresh)' : 'Cache off — every view fetches from the database', 'info', 2200);
}
function toggleDock() {
  const open = shell.classList.toggle('no-dock') === false;
  api.layout.set({ dockOpen: open });
  if (open) history.render();
  drawStatus();
}

// ---------------- commands ----------------
function command(cmd, arg) {
  closeMenus();
  if (active?.view.command?.(cmd, arg)) return;
  switch (cmd) {
    case 'new-connection': connectionDialog(); break;
    case 'new-editor': newEditor(); break;
    case 'dump': dumpDialog(active?.view.addr ? { connId: active.view.addr.connId, db: active.view.addr.db, schema: active.view.addr.schema, tables: [active.view.addr.table] } : { connId: active?.view.connId }); break;
    case 'mcp': mcpDialog(); break;
    case 'settings': settingsDialog(); break;
    case 'close-tab': if (active) closeTab(active); break;
    case 'toggle-sidebar': { const hid = shell.classList.toggle('no-sidebar'); api.layout.set({ sidebarHidden: hid }); break; }
    case 'toggle-history': toggleDock(); break;
    case 'cache': toggleCache(arg); break;
    case 'next-tab': case 'prev-tab': if (tabs.length) { const i = tabs.indexOf(active); activate(tabs[(i + (cmd === 'next-tab' ? 1 : -1) + tabs.length) % tabs.length]); } break;
    case 'run': case 'run-script': case 'explain': case 'explain-analyze': if (!active) newEditor(); break;
    default: break;
  }
}

function wire() {
  api.on.menu((cmd, arg) => command(cmd, arg));
  app.on('cmd', (cmd, arg) => command(cmd, arg));
  app.on('open-table', (addr) => {
    const v = openTab(new TableView(addr));
    if (addr.tab && v.show) v.show(addr.tab);
  });
  app.on('open-editor', (o) => newEditor(o));
  app.on('insert-text', (t) => { if (active?.view instanceof EditorView) active.view.insert(t); else newEditor({ text: t }); });
  app.on('dump', (o) => dumpDialog(o));
  app.on('mcp', (o) => { if (o && o.connId) mcpDialog(o); else { drawStatus(); } });
  app.on('edit-connection', (c) => connectionDialog(c));
  app.on('editor-changed', () => { drawTabs(); drawStatus(); persistTabs(); });
  app.on('conn-state', () => drawStatus());
  app.on('settings', () => { applyTheme(); drawStatus(); for (const t of tabs) t.view.setFontSize?.(app.state.settings.fontSize); sidebar.forget(''); sidebar.render(); });
  app.on('refresh-meta', () => {});
  app.on('data-changed', () => {});
  app.on('delete-connection', async (id) => {
    for (const t of [...tabs]) if ((t.view.addr?.connId || t.view.connId) === id) closeTab(t);
    await api.conn.remove(id);
    app.state.connections = app.state.connections.filter((c) => c.id !== id);
    app.state.live.delete(id);
    sidebar.forget(id);
    app.emit('connections');
    drawStatus();
  });
  app.on('connection-saved', async (c, connect) => {
    const i = app.state.connections.findIndex((x) => x.id === c.id);
    if (i >= 0) app.state.connections[i] = c; else app.state.connections.push(c);
    app.state.live.delete(c.id);
    app.state.errors.delete(c.id);
    sidebar.forget(c.id);
    if (connect) { sidebar.toggle(c.id, true); }
    app.emit('connections');
    drawStatus();
  });
  api.on.connState((e) => {
    if (e.state === 'connected') app.state.live.set(e.id, e.version);
    else if (e.state === 'closed' || e.state === 'error') app.state.live.delete(e.id);
    drawStatus();
  });
  api.on.mcpError((msg) => { toast(msg, 'error', 6000); api.mcp.state().then((m) => { app.state.mcp = m; app.emit('mcp', m); drawStatus(); }); });
  app.on('mcp', () => drawStatus());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
  document.addEventListener('keydown', (e) => {
    // ⌘R / ⌘W etc. come from the menu; these are the ones without menu items
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) { const t = tabs[+e.key - 1]; if (t) { e.preventDefault(); activate(t); } }
  });
}

window.addEventListener('error', (e) => console.error(e.message));
boot();
// test hook for scripted screenshots
window.__pelican = { app, tabs: () => tabs, activate: (i) => activate(tabs[i]), command, openTab, newEditor, expand: (keys) => keys.forEach((k) => sidebar.toggle(k, true)) };
