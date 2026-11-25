// Connection tree: connection → (database) → schema → tables / views → columns.
import { h, icon, clear, fmtNum, fmtBytes, debounce } from '../ui/h.js';
import { ENGINES } from '../ui/icons.js';
import { contextMenu, confirmBox, toast } from '../ui/overlay.js';
import { app, api } from '../app.js';

const LS = 'pelican.tree.open';
let open = new Set();
try { open = new Set(JSON.parse(localStorage.getItem(LS) || '[]')); } catch { /* fresh */ }
const saveOpen = debounce(() => { try { localStorage.setItem(LS, JSON.stringify([...open].slice(-400))); } catch { /* private */ } }, 400);

export function engineBadge(type, cls = '') {
  const e = ENGINES[type] || { short: '?', color: '#888' };
  return h('span', { class: 'engine ' + cls, style: { '--ec': e.color }, title: e.name }, e.short);
}

export class Sidebar {
  constructor() {
    this.filter = '';
    this.busy = new Set();
    this.tree = h('div', { class: 'tree', role: 'tree' });
    this.search = h('input', { class: 'input sm tree-search', placeholder: 'Filter tables', spellcheck: false, oninput: debounce(() => { this.filter = this.search.value.trim().toLowerCase(); this.render(); }, 120) });
    this.el = h('aside', { class: 'sidebar' },
      h('div', { class: 'sb-top drag' },
        h('span', { class: 'grow' }),
        h('button', { class: 'icon-btn', title: 'New connection (⌘N)', onclick: () => app.emit('cmd', 'new-connection') }, icon('plus')),
        h('button', { class: 'icon-btn', title: 'New SQL editor (⌘T)', onclick: () => app.emit('cmd', 'new-editor') }, icon('code')),
        h('button', { class: 'icon-btn', title: 'Dump… (⇧⌘D)', onclick: () => app.emit('cmd', 'dump') }, icon('download')),
        h('button', { class: 'icon-btn', title: 'AI access (MCP)', onclick: () => app.emit('cmd', 'mcp') }, icon('sparkles'))),
      h('div', { class: 'sb-search' }, icon('search'), this.search),
      this.tree);
    app.on('conn-state', () => this.render());
    app.on('conn-busy', (id, b) => { if (b) this.busy.add(id); else this.busy.delete(id); this.render(); });
    app.on('connections', () => this.render());
    app.on('mcp', () => this.render());
    app.on('settings', () => this.render());
    this.cache = new Map(); // node key → children data
    this.render();
  }

  toggle(key, force) {
    const want = force ?? !open.has(key);
    if (want) open.add(key); else open.delete(key);
    saveOpen();
    this.render();
  }
  async load(key, fn, refresh) {
    if (!refresh && this.cache.has(key)) return this.cache.get(key);
    const p = fn().then((v) => { this.cache.set(key, v); return v; }, (e) => { this.cache.delete(key); throw e; });
    this.cache.set(key, p);
    return p;
  }
  /** Close the connection and fold its node, so the tree does not open it again straight away. */
  async disconnect(c) {
    open.delete(c.id);
    saveOpen();
    this.forget(c.id);
    app.state.errors.delete(c.id);
    try { await api.conn.disconnect(c.id); } catch (e) { toast(e.message, 'error'); }
    app.state.live.delete(c.id);
    app.emit('conn-state', c.id);
    toast(`Disconnected from ${c.name}`, 'info', 1600);
  }
  forget(prefix) { for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k); }
  refresh(prefix) { this.forget(prefix); this.render(); }

  render() {
    const sc = this.tree.scrollTop;
    clear(this.tree);
    const conns = app.state.connections;
    if (!conns.length) {
      this.tree.append(h('div', { class: 'tree-empty' },
        h('div', { class: 'muted' }, 'No connections yet'),
        h('button', { class: 'btn primary sm', onclick: () => app.emit('cmd', 'new-connection') }, icon('plus'), 'New connection')));
      return;
    }
    for (const c of conns) this.tree.append(this.connNode(c));
    this.tree.scrollTop = sc;
  }

  row({ key, depth, label, sub, iconEl, expandable, onOpen, menu, cls = '', title, extra }) {
    const isOpen = open.has(key);
    const r = h('div', { class: 'tn ' + cls + (this.selected === key ? ' sel' : ''), style: { '--d': depth }, title: title || null, role: 'treeitem', tabindex: '-1' },
      h('span', { class: 'tn-tw' }, expandable ? icon(isOpen ? 'chevronDown' : 'chevronRight') : null),
      iconEl, h('span', { class: 'tn-label' }, label), sub != null && sub !== '' ? h('span', { class: 'tn-sub' }, sub) : null, extra);
    r.addEventListener('click', (e) => {
      this.selected = key;
      this.tree.querySelectorAll('.tn.sel').forEach((x) => x.classList.remove('sel'));
      r.classList.add('sel');
      if (expandable && (e.target.closest('.tn-tw') || !onOpen)) this.toggle(key);
    });
    r.addEventListener('dblclick', () => { if (onOpen) onOpen(); else if (expandable) this.toggle(key); });
    if (menu) r.addEventListener('contextmenu', (e) => { this.selected = key; r.classList.add('sel'); contextMenu(e, menu()); });
    return r;
  }

  status(msgOrErr, depth, retry) {
    const err = msgOrErr instanceof Error;
    return h('div', { class: 'tn tn-msg' + (err ? ' err' : ''), style: { '--d': depth } }, h('span', { class: 'tn-tw' }), err ? icon('warning') : h('span', { class: 'spin' }), h('span', { class: 'tn-label', title: err ? msgOrErr.message : null }, err ? msgOrErr.message.replace(/^(\[[^\]]*\])+\s*/, '') : msgOrErr),
      err && retry ? h('button', { class: 'link', onclick: retry }, 'Retry') : null);
  }

  /** children that load asynchronously */
  lazy(key, depth, fn, build) {
    const box = h('div', { class: 'tn-kids' });
    const v = this.cache.get(key);
    if (v && !(v instanceof Promise)) { build(v, box); return box; }
    box.append(this.status('Loading…', depth));
    this.load(key, fn).then((val) => { clear(box); build(val, box); this.applyFilterCounts(); }, (e) => { clear(box).append(this.status(e, depth, () => this.refresh(key))); });
    return box;
  }
  applyFilterCounts() {}

  connNode(c) {
    const key = c.id;
    const isLive = app.isLive(c.id);
    const err = app.state.errors.get(c.id);
    const pol = app.state.mcp.policies?.[c.id];
    const where = c.type === 'sqlite' ? (c.file || '').split('/').pop() : `${c.host || 'localhost'}:${c.port || ''}${c.database ? '/' + c.database : ''}`;
    const frag = h('div', { class: 'tn-group' });
    const dot = h('span', { class: 'dot ' + (this.busy.has(c.id) ? 'busy' : isLive ? 'on' : err ? 'err' : '') });
    frag.append(this.row({
      key, depth: 0, label: c.name, sub: where, cls: 'tn-conn', title: err || `${c.name}\n${where}${isLive ? '\n' + app.state.live.get(c.id) : ''}`,
      iconEl: h('span', { class: 'tn-ic' }, engineBadge(c.type), dot),
      extra: [pol && pol.access && pol.access !== 'off' && app.state.mcp.enabled ? h('span', { class: 'tn-ai ' + pol.access, title: `AI clients: ${pol.access === 'write' ? 'read & write' : 'read only'}${pol.scope === 'custom' ? ' (some tables)' : ''}` }, icon('sparkles')) : null,
        c.color ? h('span', { class: 'tn-color', style: { background: c.color } }) : null,
        isLive ? h('button', { class: 'tn-act', title: 'Disconnect', onclick: (e) => { e.stopPropagation(); this.disconnect(c); } }, icon('disconnect')) : null],
      expandable: true,
      onOpen: () => this.toggle(key),
      menu: () => [
        isLive ? { label: 'Disconnect', icon: 'disconnect', onClick: () => this.disconnect(c) } : { label: 'Connect', icon: 'plug', onClick: () => this.toggle(key, true) },
        { label: 'New SQL editor', icon: 'code', kbd: '⌘T', onClick: () => app.emit('open-editor', { connId: c.id }) },
        { label: 'Refresh', icon: 'refresh', onClick: () => { this.forget(c.id); api.cache.clear(c.id); app.emit('refresh-meta', c.id); this.render(); } },
        '-',
        { label: 'Dump…', icon: 'download', onClick: () => app.emit('dump', { connId: c.id }) },
        { label: 'Transfer to another database…', icon: 'transfer', onClick: () => app.emit('transfer', { connId: c.id }) },
        { label: 'AI access…', icon: 'sparkles', onClick: () => app.emit('mcp', { connId: c.id }) },
        '-',
        { label: 'Edit connection…', icon: 'edit', onClick: () => app.emit('edit-connection', c) },
        { label: 'Duplicate', icon: 'copy', onClick: () => app.emit('edit-connection', { ...c, id: undefined, name: c.name + ' copy' }) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { if (await confirmBox({ title: 'Delete connection?', message: `“${c.name}” will be removed from Pelican. The database itself is not touched.`, ok: 'Delete', danger: true })) app.emit('delete-connection', c.id); } },
      ],
    }));
    if (open.has(key)) {
      const box = h('div', { class: 'tn-kids' });
      frag.append(box);
      if (!isLive) {
        if (err) { box.append(this.status(new Error(err), 1, () => { app.state.errors.delete(c.id); this.render(); })); return frag; }
        box.append(this.status('Connecting…', 1));
        if (!this.busy.has(c.id)) app.connect(c.id).catch(() => {}); // conn-state re-renders with the result
        return frag;
      }
      const multiDb = c.type === 'postgres' && c.showAllDatabases;
      if (multiDb) box.append(this.lazy(c.id + '/dbs', 1, () => api.meta.databases(c.id), (dbs, el) => { for (const db of dbs) el.append(this.dbNode(c, db)); }));
      else box.append(this.schemaList(c, c.type === 'postgres' ? (c.database || 'postgres') : null, 1));
    }
    return frag;
  }
  dbNode(c, db) {
    const key = `${c.id}/db/${db}`;
    const g = h('div', {});
    g.append(this.row({ key, depth: 1, label: db, iconEl: icon('database', 'tn-ic2'), expandable: true,
      menu: () => [
        { label: 'New SQL editor', icon: 'code', onClick: () => app.emit('open-editor', { connId: c.id, db }) },
        { label: 'Dump database…', icon: 'download', onClick: () => app.emit('dump', { connId: c.id, db }) },
        { label: 'Transfer database…', icon: 'transfer', onClick: () => app.emit('transfer', { connId: c.id, db }) },
        { label: 'Refresh', icon: 'refresh', onClick: () => this.refresh(key) }] }));
    if (open.has(key)) g.append(this.schemaList(c, db, 2));
    return g;
  }
  schemaList(c, db, depth) {
    const key = `${c.id}/db/${db}/schemas`;
    return this.lazy(key, depth, () => api.meta.schemas(c.id, db), (schemas, el) => {
      const single = schemas.length === 1 && c.type === 'sqlite';
      if (!schemas.length) el.append(this.status(new Error('No schemas'), depth));
      for (const s of schemas) {
        if (single) { el.append(this.objectsOf(c, db, s, depth)); continue; }
        el.append(this.schemaNode(c, db, s, depth));
      }
    });
  }
  schemaNode(c, db, schema, depth) {
    const key = `${c.id}/db/${db}/s/${schema}`;
    const g = h('div', {});
    const mongo = c.type === 'mongo';
    g.append(this.row({ key, depth, label: schema, iconEl: icon(mongo || c.type === 'mysql' ? 'database' : 'schema', 'tn-ic2'), expandable: true,
      menu: () => [
        { label: 'New SQL editor here', icon: 'code', onClick: () => app.emit('open-editor', { connId: c.id, db, schema }) },
        { label: `Dump ${mongo || c.type === 'mysql' ? 'database' : 'schema'}…`, icon: 'download', onClick: () => app.emit('dump', { connId: c.id, db, schema }) },
        { label: `Transfer ${mongo || c.type === 'mysql' ? 'database' : 'schema'}…`, icon: 'transfer', onClick: () => app.emit('transfer', { connId: c.id, db, schema }) },
        { label: 'Copy name', icon: 'copy', onClick: () => api.clipboard.write(schema) },
        { label: 'Refresh', icon: 'refresh', onClick: () => { this.refresh(key); app.emit('refresh-meta', c.id); } }] }));
    if (open.has(key) || this.filter) g.append(this.objectsOf(c, db, schema, depth + 1));
    return g;
  }
  objectsOf(c, db, schema, depth) {
    const key = `${c.id}/db/${db}/s/${schema}/objects`;
    return this.lazy(key, depth, () => api.meta.objects(c.id, db, schema), (objs, el) => {
      const f = this.filter;
      const shown = f ? objs.filter((o) => o.name.toLowerCase().includes(f)) : objs;
      const tables = shown.filter((o) => o.kind !== 'view');
      const views = shown.filter((o) => o.kind === 'view');
      const groups = c.type === 'mongo' ? [['Collections', tables, 'collection'], ['Views', views, 'view']] : [['Tables', tables, 'table'], ['Views', views, 'view']];
      for (const [label, list, ic] of groups) {
        if (!list.length && (label === 'Views' || f)) continue;
        const gk = `${key}/${label}`;
        const isOpen = open.has(gk) || (f && list.length);
        el.append(this.row({ key: gk, depth, label, sub: String(list.length), iconEl: icon('folder', 'tn-ic2 folder'), expandable: true, cls: 'tn-folder' }));
        if (isOpen) for (const o of list) el.append(this.objectNode(c, db, schema, o, depth + 1, ic));
      }
    });
  }
  objectNode(c, db, schema, o, depth, ic) {
    const key = `${c.id}/db/${db}/s/${schema}/o/${o.name}`;
    const g = h('div', {});
    const addr = { connId: c.id, db, schema, table: o.name, kind: o.kind };
    const sub = o.rows != null ? fmtNum(o.rows) : '';
    const scope = app.state.mcp.policies?.[c.id];
    g.append(this.row({ key, depth, label: o.name, sub, iconEl: icon(ic, 'tn-ic2 ' + ic), expandable: true, cls: 'tn-obj',
      title: `${schema}.${o.name}${o.sub ? ' · ' + o.sub : ''}${o.rows != null ? '\n≈ ' + fmtNum(o.rows) + ' rows' : ''}${o.size ? '\n' + fmtBytes(o.size) : ''}${o.comment ? '\n' + o.comment : ''}`,
      onOpen: () => app.emit('open-table', addr),
      menu: () => [
        { label: 'Open data', icon: 'table', onClick: () => app.emit('open-table', addr) },
        { label: 'Open structure', icon: 'column', onClick: () => app.emit('open-table', { ...addr, tab: 'columns' }) },
        { label: c.type === 'mongo' ? 'Query in editor' : 'SELECT in editor', icon: 'code', onClick: () => app.emit('open-editor', { connId: c.id, db, schema, text: c.type === 'mongo' ? `db.getCollection(${JSON.stringify(o.name)}).find({}).limit(100)` : `SELECT * FROM ${app.qualified(c, schema, o.name)}${c.type === 'db2' ? ' FETCH FIRST 100 ROWS ONLY' : ' LIMIT 100'};`, run: true }) },
        { label: 'Show DDL', icon: 'file', onClick: () => app.emit('open-table', { ...addr, tab: 'ddl' }) },
        '-',
        { label: 'Dump table…', icon: 'download', onClick: () => app.emit('dump', { connId: c.id, db, schema, tables: [o.name] }) },
        o.kind !== 'view' ? { label: `Transfer ${c.type === 'mongo' ? 'collection' : 'table'}…`, icon: 'transfer', onClick: () => app.emit('transfer', { connId: c.id, db, schema, tables: [o.name] }) } : null,
        { label: 'Copy name', icon: 'copy', onClick: () => api.clipboard.write(o.name) },
        { label: 'Copy qualified name', onClick: () => api.clipboard.write(app.qualified(c, schema, o.name)) },
        scope && scope.access !== 'off' && scope.scope === 'custom' ? { label: 'Shared with AI clients?', icon: 'sparkles', onClick: () => app.emit('mcp', { connId: c.id }) } : null,
      ] }));
    if (open.has(key)) {
      g.append(this.lazy(`${key}/cols`, depth + 1, () => api.meta.columns(c.id, db, schema, o.name), (cols, el) => {
        for (const col of cols) el.append(h('div', { class: 'tn tn-col', style: { '--d': depth + 1 }, title: `${col.name} ${col.type}${col.nullable ? '' : ' NOT NULL'}${col.default != null ? ' DEFAULT ' + col.default : ''}${col.comment ? '\n' + col.comment : ''}` },
          h('span', { class: 'tn-tw' }), icon(col.pk ? 'key' : 'column', 'tn-ic2 ' + (col.pk ? 'pk' : 'col')), h('span', { class: 'tn-label' }, col.name), h('span', { class: 'tn-sub' }, col.type)));
      }));
    }
    return g;
  }
}

export function connectionSubtitle(c) {
  return c.type === 'sqlite' ? c.file : `${c.user ? c.user + '@' : ''}${c.host || 'localhost'}:${c.port || ''}${c.database ? '/' + c.database : ''}`;
}
export { toast };
