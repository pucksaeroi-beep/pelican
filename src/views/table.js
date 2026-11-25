// A table (or collection) tab: Data, Columns, Indexes, DDL.
import { h, icon, clear, fmtNum, fmtMs, ago, fmtBytes } from '../ui/h.js';
import { Grid, format, typeIcon } from '../ui/grid.js';
import { contextMenu, toast, confirmBox, modal } from '../ui/overlay.js';
import { createEditor, createLineEditor } from '../ui/code.js';
import { app, api } from '../app.js';
import { engineBadge } from './sidebar.js';

const FILTER_HISTORY = 'pelican.filters';

export class TableView {
  constructor(addr) {
    this.addr = addr; // { connId, db, schema, table, kind }
    this.conn = app.conn(addr.connId);
    this.mongo = this.conn.type === 'mongo';
    this.dialect = app.dialectOf(this.conn.type);
    this.title = addr.table;
    this.iconName = this.mongo ? 'collection' : addr.kind === 'view' ? 'view' : 'table';
    this.pageSize = app.state.settings.pageSize || 200;
    this.state = { where: '', filters: [], order: [], offset: 0 };
    this.sub = addr.tab || 'data';

    this.docs = []; // MongoDB: the documents behind the rows (relaxed EJSON), for _id and value types
    this.grid = new Grid({
      mode: 'server', dialect: this.dialect, tableName: app.qualified(this.conn, addr.schema, addr.table),
      onQuery: async ({ order, filters }) => {
        if (!(await this.okToDiscard())) { this.grid.setState({ order: this.state.order, filters: this.state.filters }); return; }
        this.state.order = order; this.state.filters = filters; this.load({ discard: true });
      },
      loadDistinct: (col, filters) => api.data.distinct({ ...this.base(), col, where: this.state.where, filters }),
      edit: {
        why: () => this.readOnlyReason(),
        colWhy: (c, ri) => this.colReason(c, ri),
        editText: (ri, c, v) => this.editText(ri, c, v),
        skipOnCopy: (c) => { const m = this.metaOf(c); return this.mongo ? this.grid.columns[c]?.name === '_id' : !!(m && (m.pk || m.auto)); },
        onChange: () => this.drawEditBar(),
        onSave: () => this.save(),
      },
    });
    const host = h('div', { class: 'input mono filter-input' });
    this.filterInput = createLineEditor({
      parent: host, lang: this.mongo ? 'mongo' : this.dialect, fontSize: 12.5,
      placeholder: this.mongo ? '{ status: "paid", total: { $gt: 100 } }   — MongoDB filter, Enter to apply' : 'Enter a SQL expression to filter results, e.g.  total > 100 AND status = \'paid\'   — Enter to apply',
      recent: () => this.recentFilters(),
      onEnter: () => this.applyWhere(),
      onEscape: () => { if (this.filterInput.value) { this.filterInput.value = ''; this.applyWhere(); } else this.grid.el.focus(); },
    });
    this.filterHost = host;
    this.chips = h('div', { class: 'chips' });
    this.foot = h('div', { class: 'res-foot' });
    this.editBar = h('div', { class: 'edit-bar', style: { display: 'none' } });
    this.dataPane = h('div', { class: 'pane data-pane' },
      h('div', { class: 'filter-bar' },
        h('span', { class: 'filter-lbl' }, this.mongo ? icon('braces') : 'WHERE'),
        host,
        h('button', { class: 'icon-btn', title: 'Recent filters', onclick: (e) => this.recentMenu(e) }, icon('history')),
        h('button', { class: 'icon-btn', title: 'Apply filter (Enter)', onclick: () => this.applyWhere() }, icon('play')),
        h('button', { class: 'icon-btn', title: 'Clear all filters', onclick: () => { this.filterInput.value = ''; this.state.filters = []; this.grid.setState({ filters: [] }); this.applyWhere(); } }, icon('x')),
        h('span', { class: 'tb-sep' }),
        this.addBtn = h('button', { class: 'icon-btn', title: 'Add a row', onclick: () => { const r = this.grid.addRow(); if (r != null) this.grid.startEdit(r, this.firstEditable()); } }, icon('plus')),
        h('button', { class: 'icon-btn', title: 'Refresh from the database (⌘R)', onclick: () => this.load({ refresh: true }) }, icon('refresh')),
        h('button', { class: 'icon-btn', title: 'Record panel (Space)', onclick: () => this.grid.toggleRecord() }, icon('rows')),
        h('button', { class: 'icon-btn', title: 'Export…', onclick: (e) => this.exportMenu(e) }, icon('upload'))),
      this.chips, this.grid.el, this.editBar, this.foot);

    this.panes = { data: this.dataPane, columns: h('div', { class: 'pane pad' }), indexes: h('div', { class: 'pane pad' }), ddl: h('div', { class: 'pane ddl-pane' }), partitions: h('div', { class: 'pane pad' }) };
    this.tabsEl = h('div', { class: 'subtabs' });
    this.el = h('div', { class: 'view table-view' },
      h('div', { class: 'view-head' }, this.tabsEl, h('span', { class: 'grow' }), this.crumbs()),
      h('div', { class: 'view-body' }, Object.values(this.panes)));
    this.drawTabs();
    this.show(this.sub);
    this.load();
    this.loadColumns();
  }
  async loadColumns(refresh) {
    try {
      this.meta = await api.meta.columns(this.addr.connId, this.addr.db, this.addr.schema, this.addr.table);
      for (const m of this.meta) m.auto = this.isAuto(m);
      this.filterInput.setColumns(this.meta);
      this.addBtn.disabled = !!this.readOnlyReason();
      this.addBtn.title = this.readOnlyReason() || 'Add a row';
    } catch (e) { this.metaError = e.message; }
    if (this.conn.type === 'postgres') {
      this.parts = await api.meta.partitions(this.addr.connId, this.addr.db, this.addr.schema, this.addr.table, refresh).catch(() => null);
      if (this.parts) { this.drawTabs(); this.drawPartitions(); }
    }
  }
  /** Partitioned table: its key and partitions. Partition: the table it belongs to and its bound. */
  drawPartitions() {
    const p = this.parts;
    const el = clear(this.panes.partitions);
    if (!p) return;
    const open = (schema, table) => app.emit('open-table', { connId: this.addr.connId, db: this.addr.db, schema, table, kind: 'table' });
    if (p.partitionOf) {
      el.append(h('div', { class: 'pane-title' }, 'Partition of'),
        h('p', {}, h('button', { class: 'link', onclick: () => open(p.partitionOf.schema, p.partitionOf.table) }, `${p.partitionOf.schema}.${p.partitionOf.table}`), ' ', h('code', { class: 'part-key' }, p.partitionOf.bound)),
        p.root && p.root.table !== p.partitionOf.table ? h('p', { class: 'muted' }, 'Top-level table: ', h('button', { class: 'link', onclick: () => open(p.root.schema, p.root.table) }, `${p.root.schema}.${p.root.table}`)) : null,
        h('p', { class: 'muted' }, 'Rows of this partition are also rows of the partitioned table. Query the partitioned table with a filter on its partition key and PostgreSQL reads only the partitions that can match.'));
    }
    if (p.key) {
      const g = new Grid({ mode: 'local', onOpenRow: (row) => open(row[0], row[1]) });
      g.setData({ columns: [{ name: 'schema' }, { name: 'partition' }, { name: 'bound' }, { name: 'level', type: 'int' }, { name: 'rows (est.)', type: 'int' }, { name: 'size' }, { name: 'sub-partitioned by' }],
        rows: p.partitions.map((x) => [x.schema, x.name, x.bound.replace(/^FOR VALUES /, ''), x.level, x.rows, x.size != null ? fmtBytes(x.size) : null, x.key ?? null]) });
      el.append(h('div', { class: 'pane-title' }, 'PARTITION BY ', h('code', { class: 'part-key' }, p.key), ` · ${p.partitions.length} partitions — double-click one to open it`), h('div', { class: 'mini-grid' }, g.el));
    }
  }
  isAuto(m) {
    return m.ident === 'a' || m.ident === 'd' || m.ident === true || /^nextval\(/i.test(String(m.default || '')) || /auto_increment/i.test(m.extra || '') || (this.conn.type === 'sqlite' && m.pk && /^integer$/i.test(m.type) && this.meta.filter((x) => x.pk).length === 1);
  }

  // ---------- editing ----------
  metaOf(c) { const name = this.grid.columns[c]?.name; return this.meta?.find((m) => m.name === name); }
  /** Columns that pick out one row: the primary key, or every comparable column when there is none. */
  keyCols() {
    if (!this.meta) return [];
    if (this.mongo) return ['_id'];
    const pk = this.meta.filter((m) => m.pk).map((m) => m.name);
    if (pk.length) return pk;
    return this.meta.filter((m) => !/json|xml|clob|blob|bytea|binary|geometry|graphic/i.test(m.type || '')).map((m) => m.name);
  }
  readOnlyReason() {
    if (this.addr.kind === 'view') return 'Views are read-only here — open the table it reads from to edit.';
    if (this.conn.readOnly) return 'This connection is opened read-only (Edit connection to change it).';
    if (this.metaError) return 'Columns could not be read: ' + this.metaError;
    if (!this.meta) return 'Loading the table\'s columns…';
    if (!this.keyCols().length) return 'This table has no primary key or comparable column, so a row cannot be picked out safely.';
    return null;
  }
  colReason(c, ri) {
    const col = this.grid.columns[c];
    if (!col) return 'Unknown column';
    const m = this.metaOf(c);
    const added = this.grid.added.has(ri);
    if (this.mongo) return col.name === '_id' && !added ? '_id cannot be changed. Duplicate the document (⌘D) to give it a new _id.' : null;
    if (!m) return `${col.name} is not a column of this table.`;
    if (typeIcon(m.type) === 'binary' || typeIcon(col.type) === 'binary') return 'Binary values cannot be edited in the grid.';
    if (m.gen === 's' || (/GENERATED/i.test(m.extra || '') && !/DEFAULT_GENERATED/i.test(m.extra || ''))) return `${col.name} is a generated column.`;
    if (m.ident === 'a') return `${col.name} is GENERATED ALWAYS — the database fills it in.`;
    const v = this.grid.rows[ri]?.[c];
    if (typeof v === 'string' && v.length >= 20000 && v.endsWith('…')) return 'This value is too long to edit in the grid — use an UPDATE in the SQL editor.';
    return null;
  }
  editText(ri, c, v) {
    if (!this.mongo) return null;
    const d = this.docs[ri]?.[this.grid.columns[c].name];
    if (d && typeof d === 'object' && !this.grid.changes.get(ri)?.has(c)) {
      if ('$oid' in d) return d.$oid;
      if ('$date' in d) return typeof d.$date === 'string' ? d.$date : d.$date.$numberLong ? new Date(+d.$date.$numberLong).toISOString() : String(d.$date);
      for (const k of ['$numberDecimal', '$numberLong', '$numberInt', '$numberDouble']) if (k in d) return d[k];
      return JSON.stringify(d, null, 2);
    }
    return null;
  }
  firstEditable() { const i = this.grid.columns.findIndex((c, ci) => !this.colReason(ci, this.grid.rows.length - 1) && !this.metaOf(ci)?.auto && c.name !== '_id'); return Math.max(0, i); }
  changesList() {
    const p = this.grid.pending();
    const cols = this.grid.columns;
    const keys = this.keyCols();
    const idx = (name) => cols.findIndex((c) => c.name === name);
    const key = (ri, row) => (this.mongo ? [{ col: '_id', v: this.docs[ri]?._id }] : keys.map((k) => ({ col: k, v: row[idx(k)] ?? null })));
    const orig = (ri, c) => (this.mongo ? this.docs[ri]?.[cols[c].name] : undefined);
    const list = [];
    for (const d of p.deletes) list.push({ op: 'delete', key: key(d.ri, d.row) });
    for (const u of p.updates) list.push({ op: 'update', key: key(u.ri, u.row), set: [...u.set].map(([c, v]) => ({ col: cols[c].name, v, orig: orig(u.ri, c) })) });
    for (const n of p.inserts) list.push({ op: 'insert', values: [...n.values].filter(([, v]) => v !== undefined).map(([c, v]) => ({ col: cols[c].name, v, orig: this.mongo ? this.sampleOf(cols[c].name) : undefined })), firstCol: this.meta?.[0]?.name });
    return list;
  }
  /** a value of this field in some loaded document, so a new document's field gets the same type */
  sampleOf(name) { for (const d of this.docs) if (d && d[name] !== undefined && d[name] !== null) return d[name]; return undefined; }
  drawEditBar() {
    clear(this.editBar);
    const n = this.grid.counts();
    const total = n.updated + n.added + n.deleted;
    this.editBar.style.display = total ? '' : 'none';
    app.emit('editor-changed');
    if (!total) return;
    const parts = [n.updated && `${n.updated} edited`, n.added && `${n.added} new`, n.deleted && `${n.deleted} to delete`].filter(Boolean);
    this.editBar.append(icon('edit'), h('b', {}, `${total} unsaved change${total > 1 ? 's' : ''}`), h('span', { class: 'muted' }, parts.join(' · ')), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm ghost', onclick: () => this.preview() }, icon('code'), 'Preview SQL'),
      h('button', { class: 'btn sm', onclick: () => this.grid.revertAll() }, icon('undo'), 'Discard'),
      this.saveBtn = h('button', { class: 'btn sm primary', onclick: () => this.save() }, icon('save'), 'Save', h('kbd', {}, '⌘S')));
  }
  dirty() { return this.grid.dirty(); }
  async okToDiscard() {
    this.grid.commitEdit(false);
    if (!this.grid.dirty()) return true;
    const n = this.grid.counts();
    const ok = await confirmBox({ title: 'Discard unsaved changes?', message: `${n.updated + n.added + n.deleted} change${n.updated + n.added + n.deleted > 1 ? 's' : ''} to ${this.addr.table} have not been saved.`, ok: 'Discard', danger: true });
    if (ok) this.grid.revertAll();
    return ok;
  }
  async preview() {
    this.grid.commitEdit(false);
    try {
      const text = await api.data.previewEdits({ ...this.base(), changes: this.changesList() });
      const host = h('div', { class: 'preview-code' });
      let ed;
      const m = modal({ title: 'Changes to save', subtitle: this.mongo ? 'Run one after another, in this order.' : 'Run together in one transaction — if any statement does not touch exactly one row, nothing is saved.', width: 760, body: host, onClose: () => ed?.destroy(),
        foot: [h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => { api.clipboard.write(text); toast('Copied', 'ok', 1200); } }, icon('copy'), 'Copy'), h('button', { class: 'btn', onclick: () => m.close() }, 'Close'), h('button', { class: 'btn primary', onclick: () => { m.close(); this.save(); } }, icon('save'), 'Save')] });
      ed = createEditor({ parent: host, doc: text, lang: this.mongo ? 'mongo' : this.dialect, readOnly: true, fontSize: app.state.settings.fontSize });
    } catch (e) { toast(e.message, 'error', 6000); }
  }
  async save() {
    this.grid.commitEdit(false);
    if (!this.grid.dirty() || this.saving) return;
    let changes;
    try { changes = this.changesList(); } catch (e) { toast(e.message, 'error'); return; }
    this.saving = true;
    if (this.saveBtn) this.saveBtn.disabled = true;
    try {
      await api.data.applyEdits({ ...this.base(), changes });
      toast(`Saved ${changes.length} change${changes.length > 1 ? 's' : ''} to ${this.addr.table}`, 'ok', 2200);
      // keep rows where they are (a reload without ORDER BY can shuffle them); new rows need the database's
      // defaults (ids…) and MongoDB documents their stored form, so those reload
      if (this.mongo || this.grid.added.size) { this.grid.revertAll(); await this.load({ refresh: true, discard: true, keepScroll: true }); }
      else { this.grid.applySaved(); this.drawEditBar(); }
    } catch (e) {
      toast(e.message, 'error', 8000);
    } finally { this.saving = false; if (this.saveBtn) this.saveBtn.disabled = false; }
  }
  base() { return { connId: this.addr.connId, db: this.addr.db, schema: this.addr.schema, table: this.addr.table }; }
  crumbs() {
    const c = this.conn;
    return h('div', { class: 'crumbs' }, engineBadge(c.type, 'sm'), h('span', {}, c.name), this.addr.db && c.showAllDatabases ? [icon('chevronRight'), h('span', {}, this.addr.db)] : null,
      this.addr.schema && c.type !== 'sqlite' ? [icon('chevronRight'), h('span', {}, this.addr.schema)] : null, icon('chevronRight'), h('b', {}, this.addr.table));
  }
  drawTabs() {
    clear(this.tabsEl);
    const tabs = [['data', 'Data', 'table'], ['columns', this.mongo ? 'Fields' : 'Columns', 'column'], ['indexes', 'Indexes & keys', 'index'], ['ddl', this.mongo ? 'Definition' : 'DDL', 'file']];
    if (this.parts) tabs.splice(3, 0, ['partitions', this.parts.key ? `Partitions (${this.parts.partitions.length})` : 'Partition of', 'layers']);
    for (const [k, label, ic] of tabs) this.tabsEl.append(h('button', { class: 'subtab' + (this.sub === k ? ' on' : ''), onclick: () => this.show(k) }, icon(ic), label));
  }
  show(k) {
    this.sub = k;
    this.drawTabs();
    for (const [name, el] of Object.entries(this.panes)) el.style.display = name === k ? '' : 'none';
    if (k !== 'data' && k !== 'partitions' && !this.metaLoaded) this.loadMeta();
  }

  async applyWhere() {
    if (!(await this.okToDiscard())) return;
    const w = this.filterInput.value.trim();
    this.state.where = w;
    if (w) {
      try {
        const all = JSON.parse(localStorage.getItem(FILTER_HISTORY) || '{}');
        const list = [w, ...(all[this.histKey()] || []).filter((x) => x !== w)].slice(0, 30);
        all[this.histKey()] = list;
        localStorage.setItem(FILTER_HISTORY, JSON.stringify(all));
      } catch { /* private mode */ }
    }
    this.load({ discard: true });
  }
  histKey() { return `${this.addr.connId}\u0000${this.addr.db || ''}\u0000${this.addr.schema}\u0000${this.addr.table}`; }
  recentFilters() { try { return JSON.parse(localStorage.getItem(FILTER_HISTORY) || '{}')[this.histKey()] || []; } catch { return []; } }
  recentMenu(e) {
    const list = this.recentFilters();
    contextMenu({ anchor: e.currentTarget }, list.length ? [{ header: 'Recent filters' }, ...list.slice(0, 20).map((v) => ({ label: v.length > 90 ? v.slice(0, 90) + '…' : v, onClick: () => { this.filterInput.value = v; this.applyWhere(); } }))] : [{ header: 'No recent filters yet' }]);
  }

  async load({ refresh = false, more = false, discard = false, keepScroll = false } = {}) {
    if (!discard && !more && !(await this.okToDiscard())) return;
    const scroll = keepScroll ? [this.grid.scroller.scrollTop, this.grid.scroller.scrollLeft] : null;
    const offset = more ? this.state.offset + this.pageSize : 0;
    const seq = (this.seq = (this.seq || 0) + 1);
    this.setFoot('loading');
    this.drawChips();
    try {
      const r = await api.data.table({ ...this.base(), where: this.state.where, filters: this.state.filters, order: this.state.order, limit: this.pageSize, offset, refresh });
      if (seq !== this.seq) return;
      this.state.offset = offset;
      if (more) { this.grid.appendRows(r.result.rows); this.docs.push(...(r.result.docs || [])); }
      else { this.grid.setData(r.result, { keepState: true }); this.docs = r.result.docs || []; }
      if (scroll) { this.grid.scroller.scrollTop = scroll[0]; this.grid.scroller.scrollLeft = scroll[1]; }
      this.drawEditBar();
      this.grid.setState({ order: this.state.order, filters: this.state.filters });
      this.last = r;
      this.hasMore = r.result.truncated;
      this.error = null;
      this.setFoot();
    } catch (e) {
      if (seq !== this.seq) return;
      this.error = e.message;
      this.setFoot();
    }
  }
  drawChips() {
    clear(this.chips);
    const opText = { in: 'in', nin: 'not in', eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', starts: 'starts with', null: 'is NULL', notnull: 'is not NULL' };
    for (const f of this.state.filters) {
      const vals = (f.values || []).map((v) => (v === null ? 'NULL' : typeof v === 'object' ? v.$oid || v.$date || JSON.stringify(v) : String(v)));
      const text = ['null', 'notnull'].includes(f.op) ? '' : vals.length > 3 ? `${vals.slice(0, 3).join(', ')} +${vals.length - 3}` : vals.join(', ');
      this.chips.append(h('span', { class: 'chip filter-chip' }, icon('filterOn'), h('b', {}, f.col), ` ${opText[f.op]} `, text,
        h('button', { class: 'chip-x', title: 'Remove', onclick: () => { this.state.filters = this.state.filters.filter((x) => x !== f); this.grid.setState({ filters: this.state.filters }); this.load(); } }, icon('x'))));
    }
    this.chips.style.display = this.state.filters.length ? '' : 'none';
  }
  setFoot(state) {
    clear(this.foot);
    if (state === 'loading') { this.foot.append(h('span', { class: 'spin' }), h('span', { class: 'muted' }, 'Loading…')); return; }
    if (this.error) { this.foot.append(h('span', { class: 'err-text' }, icon('warning'), this.error)); return; }
    const r = this.last;
    if (!r) return;
    const n = this.grid.rows.length;
    this.foot.append(
      h('span', {}, h('b', {}, fmtNum(n)), ` row${n === 1 ? '' : 's'}${this.hasMore ? '+' : ''}`),
      h('span', { class: 'muted' }, r.cached ? '' : fmtMs(r.ms)),
      r.cached ? h('button', { class: 'chip cache-chip', title: 'Served from Pelican\'s cache — click to fetch fresh rows (⌘R)', onclick: () => this.load({ refresh: true }) }, icon('zap'), `cached ${ago(r.cached.at)}`, icon('refresh')) : null,
      this.hasMore ? h('button', { class: 'btn sm', onclick: () => this.load({ more: true }) }, `Load ${this.pageSize} more`) : null,
      h('span', { class: 'grow' }),
      this.countEl = h('button', { class: 'btn sm ghost', title: 'Count all matching rows', onclick: () => this.count() }, icon('count'), 'Count'),
      h('span', { class: 'muted mono sql-peek', title: r.sql }, r.sql));
  }
  async count() {
    this.countEl.disabled = true;
    try {
      const n = await api.data.count({ ...this.base(), where: this.state.where, filters: this.state.filters });
      clear(this.countEl).append(icon('count'), `${fmtNum(n)} total`);
    } catch (e) { toast(e.message, 'error'); } finally { this.countEl.disabled = false; }
  }
  exportMenu(e) {
    const save = async (fmt, ext) => {
      const text = this.grid.exportText(fmt);
      const p = await api.file.save({ name: `${this.addr.table}.${ext}`, content: text, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (p) toast(`Saved ${p.split('/').pop()}`, 'ok');
    };
    contextMenu({ anchor: e.currentTarget }, [
      { header: `Export ${fmtNum(this.grid.view.length)} loaded rows` },
      { label: 'CSV', onClick: () => save('csv', 'csv') },
      { label: 'JSON', onClick: () => save('json', 'json') },
      { label: 'Markdown table', onClick: () => save('md', 'md') },
      !this.mongo ? { label: 'SQL INSERT statements', onClick: () => save('insert', 'sql') } : null,
      '-',
      { label: 'Dump the whole table…', icon: 'download', onClick: () => app.emit('dump', { connId: this.addr.connId, db: this.addr.db, schema: this.addr.schema, tables: [this.addr.table] }) },
    ]);
  }

  async loadMeta(refresh) {
    this.metaLoaded = true;
    for (const k of ['columns', 'indexes', 'ddl']) clear(this.panes[k]).append(h('div', { class: 'muted pad' }, h('span', { class: 'spin' }), ' Loading…'));
    try {
      const m = await api.meta.table(this.addr.connId, this.addr.db, this.addr.schema, this.addr.table, refresh);
      const cols = new Grid({ mode: 'local' });
      cols.setData({ columns: [{ name: '#', type: 'int' }, { name: 'name' }, { name: 'type' }, { name: 'nullable', type: 'bool' }, { name: 'default' }, { name: 'key' }, { name: 'comment' }],
        rows: m.columns.map((c, i) => [i + 1, c.name, c.type, c.nullable, c.default ?? null, c.pk ? 'PK' : '', c.comment ?? null]) });
      clear(this.panes.columns).append(h('div', { class: 'pane-title' }, `${m.columns.length} ${this.mongo ? 'fields (sampled from 200 documents)' : 'columns'}`), cols.el);
      const ix = new Grid({ mode: 'local' });
      ix.setData({ columns: [{ name: 'name' }, { name: 'columns' }, { name: 'unique', type: 'bool' }, { name: 'primary', type: 'bool' }, { name: 'definition' }], rows: m.indexes.map((i) => [i.name, i.columns, i.unique, i.primary, i.def]) });
      const fk = new Grid({ mode: 'local' });
      fk.setData({ columns: [{ name: 'name' }, { name: 'references' }, { name: 'definition' }], rows: m.fks.map((f) => [f.name, `${f.ref_schema}.${f.ref_table}`, f.def]) });
      clear(this.panes.indexes).append(h('div', { class: 'pane-title' }, `Indexes (${m.indexes.length})`), h('div', { class: 'mini-grid' }, ix.el),
        h('div', { class: 'pane-title' }, `Foreign keys (${m.fks.length})`), h('div', { class: 'mini-grid' }, fk.el));
      clear(this.panes.ddl);
      const bar = h('div', { class: 'ddl-bar' }, h('span', { class: 'muted' }, this.mongo ? 'mongosh' : 'Generated from the catalog'), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => { api.clipboard.write(m.ddl); toast('DDL copied', 'ok', 1400); } }, icon('copy'), 'Copy'),
        h('button', { class: 'btn sm', onclick: () => app.emit('open-editor', { connId: this.addr.connId, db: this.addr.db, schema: this.addr.schema, text: m.ddl }) }, icon('code'), 'Open in editor'));
      const host = h('div', { class: 'ddl-code' });
      this.panes.ddl.append(bar, host);
      this.ddlEd?.destroy();
      this.ddlEd = createEditor({ parent: host, doc: m.ddl, lang: this.mongo ? 'mongo' : this.dialect, readOnly: true, fontSize: app.state.settings.fontSize });
    } catch (e) {
      for (const k of ['columns', 'indexes', 'ddl']) clear(this.panes[k]).append(h('div', { class: 'err-text pad' }, icon('warning'), e.message));
      this.metaLoaded = false;
    }
  }
  command(cmd) {
    if (cmd === 'refresh') { this.load({ refresh: true }); if (this.metaLoaded) this.loadMeta(true); this.loadColumns(true); return true; }
    if (cmd === 'save') { this.save(); return true; }
    if (cmd === 'find') { this.filterInput.focus(); return true; }
    return false;
  }
  focus() { if (this.sub === 'data') this.grid.el.focus({ preventScroll: true }); }
  destroy() { this.ddlEd?.destroy(); this.filterInput.destroy(); }
  key() { return `table:${this.addr.connId}:${this.addr.db}:${this.addr.schema}:${this.addr.table}`; }
}
export { format };
