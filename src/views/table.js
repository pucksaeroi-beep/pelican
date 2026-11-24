// A table (or collection) tab: Data, Columns, Indexes, DDL.
import { h, icon, clear, fmtNum, fmtMs, ago } from '../ui/h.js';
import { Grid, format } from '../ui/grid.js';
import { contextMenu, toast } from '../ui/overlay.js';
import { createEditor } from '../ui/code.js';
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

    this.grid = new Grid({
      mode: 'server', dialect: this.dialect, tableName: app.qualified(this.conn, addr.schema, addr.table),
      onQuery: ({ order, filters }) => { this.state.order = order; this.state.filters = filters; this.load(); },
      loadDistinct: (col, filters) => api.data.distinct({ ...this.base(), col, where: this.state.where, filters }),
    });
    this.filterInput = h('input', { class: 'input mono filter-input', spellcheck: false, list: 'pel-filter-hist-' + addr.connId,
      placeholder: this.mongo ? '{ status: "paid", total: { $gt: 100 } }   — MongoDB filter, Enter to apply' : 'Enter a SQL expression to filter results, e.g.  total > 100 AND status = \'paid\'   — Enter to apply',
      onkeydown: (e) => { if (e.key === 'Enter') this.applyWhere(); if (e.key === 'Escape') { this.filterInput.value = ''; this.applyWhere(); } } });
    this.chips = h('div', { class: 'chips' });
    this.foot = h('div', { class: 'res-foot' });
    this.dataPane = h('div', { class: 'pane data-pane' },
      h('div', { class: 'filter-bar' },
        h('span', { class: 'filter-lbl' }, this.mongo ? icon('braces') : 'WHERE'),
        this.filterInput,
        h('button', { class: 'icon-btn', title: 'Apply filter (Enter)', onclick: () => this.applyWhere() }, icon('play')),
        h('button', { class: 'icon-btn', title: 'Clear all filters', onclick: () => { this.filterInput.value = ''; this.state.filters = []; this.grid.setState({ filters: [] }); this.applyWhere(); } }, icon('x')),
        h('span', { class: 'tb-sep' }),
        h('button', { class: 'icon-btn', title: 'Refresh from the database (⌘R)', onclick: () => this.load({ refresh: true }) }, icon('refresh')),
        h('button', { class: 'icon-btn', title: 'Record panel (↵)', onclick: () => this.grid.toggleRecord() }, icon('rows')),
        h('button', { class: 'icon-btn', title: 'Export…', onclick: (e) => this.exportMenu(e) }, icon('upload'))),
      this.chips, this.grid.el, this.foot);

    this.panes = { data: this.dataPane, columns: h('div', { class: 'pane pad' }), indexes: h('div', { class: 'pane pad' }), ddl: h('div', { class: 'pane ddl-pane' }) };
    this.tabsEl = h('div', { class: 'subtabs' });
    this.el = h('div', { class: 'view table-view' },
      h('div', { class: 'view-head' }, this.tabsEl, h('span', { class: 'grow' }), this.crumbs()),
      h('div', { class: 'view-body' }, Object.values(this.panes)));
    this.drawTabs();
    this.show(this.sub);
    this.load();
    this.refreshHistList();
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
    for (const [k, label, ic] of tabs) this.tabsEl.append(h('button', { class: 'subtab' + (this.sub === k ? ' on' : ''), onclick: () => this.show(k) }, icon(ic), label));
  }
  show(k) {
    this.sub = k;
    this.drawTabs();
    for (const [name, el] of Object.entries(this.panes)) el.style.display = name === k ? '' : 'none';
    if (k !== 'data' && !this.metaLoaded) this.loadMeta();
  }

  applyWhere() {
    const w = this.filterInput.value.trim();
    this.state.where = w;
    if (w) {
      try {
        const all = JSON.parse(localStorage.getItem(FILTER_HISTORY) || '{}');
        const list = [w, ...(all[this.addr.connId] || []).filter((x) => x !== w)].slice(0, 30);
        all[this.addr.connId] = list;
        localStorage.setItem(FILTER_HISTORY, JSON.stringify(all));
      } catch { /* private mode */ }
      this.refreshHistList();
    }
    this.load();
  }
  refreshHistList() {
    const id = 'pel-filter-hist-' + this.addr.connId;
    let dl = document.getElementById(id);
    if (!dl) { dl = h('datalist', { id }); document.body.append(dl); }
    clear(dl);
    try { for (const v of JSON.parse(localStorage.getItem(FILTER_HISTORY) || '{}')[this.addr.connId] || []) dl.append(h('option', { value: v })); } catch { /* none */ }
  }

  async load({ refresh = false, more = false } = {}) {
    const offset = more ? this.state.offset + this.pageSize : 0;
    const seq = (this.seq = (this.seq || 0) + 1);
    this.setFoot('loading');
    this.drawChips();
    try {
      const r = await api.data.table({ ...this.base(), where: this.state.where, filters: this.state.filters, order: this.state.order, limit: this.pageSize, offset, refresh });
      if (seq !== this.seq) return;
      this.state.offset = offset;
      if (more) this.grid.appendRows(r.result.rows);
      else this.grid.setData(r.result, { keepState: true });
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
    if (cmd === 'refresh') { this.load({ refresh: true }); if (this.metaLoaded) this.loadMeta(true); return true; }
    if (cmd === 'find') { this.filterInput.focus(); return true; }
    return false;
  }
  focus() { if (this.sub === 'data') this.grid.el.focus({ preventScroll: true }); }
  destroy() { this.ddlEd?.destroy(); }
  key() { return `table:${this.addr.connId}:${this.addr.db}:${this.addr.schema}:${this.addr.table}`; }
}
export { format };
