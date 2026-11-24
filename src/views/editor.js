// SQL editor tab (MongoDB shell for MongoDB connections): run the statement under the cursor or the whole
// script, explain it, and look at results with the same grid, filters and record panel as the Data tab.
import { h, icon, clear, uid, fmtNum, fmtMs, ago, debounce, dragger } from '../ui/h.js';
import { Grid } from '../ui/grid.js';
import { planView } from '../ui/plan.js';
import { contextMenu, toast } from '../ui/overlay.js';
import { createEditor } from '../ui/code.js';
import { splitStatements, statementAt } from '../lib/sqlsplit.js';
import { app, api } from '../app.js';
import { engineBadge } from './sidebar.js';

const LIMITS = [100, 500, 1000, 5000, 20000];

export class EditorView {
  constructor({ id, connId, db, schema, text = '', title, run } = {}) {
    this.id = id || uid('s');
    this.session = this.id;
    this.connId = connId || app.state.connections[0]?.id || null;
    this.db = db ?? null;
    this.schema = schema ?? null;
    this.title = title || 'Script';
    this.iconName = 'code';
    this.results = [];
    this.active = null;
    this.log = [];
    this.maxRows = app.state.settings.editorMaxRows || 1000;

    this.connSel = h('select', { class: 'input sm sel-conn', title: 'Connection', onchange: () => this.setConn(this.connSel.value) });
    this.dbSel = h('select', { class: 'input sm', title: 'Database', onchange: () => { this.db = this.dbSel.value; this.schema = null; this.loadSchemas(); this.changed(); } });
    this.schemaSel = h('select', { class: 'input sm', title: 'Schema for unqualified names', onchange: () => { this.schema = this.schemaSel.value; this.loadCompletion(); this.changed(); } });
    this.limitSel = h('select', { class: 'input sm', title: 'Maximum rows to fetch', onchange: () => { this.maxRows = +this.limitSel.value; } }, LIMITS.map((n) => h('option', { value: n, selected: n === this.maxRows }, fmtNum(n) + ' rows')));
    this.runBtn = h('button', { class: 'btn sm primary run-btn', title: 'Run statement at cursor (⌘↵)', onclick: () => this.run() }, icon('play'), 'Run');
    this.cancelBtn = h('button', { class: 'btn sm danger', style: { display: 'none' }, title: 'Cancel (⌘.)', onclick: () => this.cancel() }, icon('stop'), 'Cancel');

    const host = h('div', { class: 'ed-host' });
    this.resTabs = h('div', { class: 'res-tabs' });
    this.resBody = h('div', { class: 'res-body' });
    this.resFoot = h('div', { class: 'res-foot' });
    this.results_el = h('div', { class: 'ed-results' }, this.resTabs, this.resBody, this.resFoot);
    const splitter = h('div', { class: 'hsplit', title: 'Drag to resize' });
    this.top = h('div', { class: 'ed-top' }, host);
    this.el = h('div', { class: 'view editor-view' },
      h('div', { class: 'view-head ed-bar' },
        this.connBadge = h('span', {}), this.connSel, this.dbSel, this.schemaSel,
        h('span', { class: 'tb-sep' }),
        this.runBtn, this.cancelBtn,
        h('button', { class: 'btn sm', title: 'Run every statement (⇧⌘↵)', onclick: () => this.runScript() }, icon('playAll'), 'Run script'),
        h('button', { class: 'btn sm', title: 'Explain plan (⌘E)', onclick: () => this.explain(false) }, icon('plan'), 'Explain'),
        h('button', { class: 'btn sm ghost', title: 'Explain analyze — runs the statement (⇧⌘E)', onclick: () => this.explain(true) }, 'Analyze'),
        h('span', { class: 'grow' }),
        this.limitSel),
      h('div', { class: 'ed-split' }, this.top, splitter, this.results_el));
    const saved = app.state.layout?.editorTop;
    if (saved) this.top.style.height = saved + 'px';
    dragger(splitter, { axis: 'y', onStart: () => this.top.offsetHeight, onMove: (d, h0) => { this.top.style.height = Math.max(80, Math.min(this.el.offsetHeight - 140, h0 + d)) + 'px'; }, onEnd: () => api.layout.set({ editorTop: this.top.offsetHeight }) });

    this.ed = createEditor({
      parent: host, doc: text, lang: 'pg', fontSize: app.state.settings.fontSize,
      onChange: debounce((t) => { api.scripts.save({ id: this.id, text: t }); this.changed(); }, 400),
      keys: [
        { key: 'Mod-Enter', run: () => { this.run(); return true; } },
        { key: 'Shift-Mod-Enter', run: () => { this.runScript(); return true; } },
        { key: 'Mod-e', run: () => { this.explain(false); return true; } },
        { key: 'Shift-Mod-e', run: () => { this.explain(true); return true; } },
      ],
    });
    this.fillConns();
    this.setConn(this.connId, true);
    this.drawResults();
    app.on('connections', () => this.fillConns());
    if (run) setTimeout(() => this.run(), 50);
  }

  get conn() { return app.conn(this.connId); }
  get lang() { const c = this.conn; return c ? app.dialectOf(c.type) : 'pg'; }
  changed() { app.emit('editor-changed', this); }
  meta() { return { id: this.id, connId: this.connId, db: this.db, schema: this.schema, title: this.title }; }

  fillConns() {
    clear(this.connSel);
    if (!app.state.connections.length) this.connSel.append(h('option', { value: '' }, 'No connections'));
    for (const c of app.state.connections) this.connSel.append(h('option', { value: c.id, selected: c.id === this.connId }, c.name));
  }
  async setConn(id, initial) {
    if (!initial && this.connId && this.connId !== id) api.data.endSession(this.connId, this.session).catch(() => {});
    this.connId = id;
    if (!initial) { this.db = null; this.schema = null; }
    const c = this.conn;
    clear(this.connBadge).append(c ? engineBadge(c.type, 'sm') : '');
    this.ed.setLang(this.lang);
    this.dbSel.style.display = c?.type === 'postgres' && c.showAllDatabases ? '' : 'none';
    this.changed();
    if (!c) return;
    try {
      await app.connect(c.id);
      if (c.type === 'postgres') {
        const dbs = await api.meta.databases(c.id);
        this.db = this.db || c.database || dbs[0];
        clear(this.dbSel).append(dbs.map((d) => h('option', { value: d, selected: d === this.db }, d)));
      }
      await this.loadSchemas();
    } catch (e) { this.logLine('error', e.message); }
  }
  async loadSchemas() {
    const c = this.conn;
    clear(this.schemaSel);
    if (c.type === 'sqlite') { this.schemaSel.style.display = 'none'; this.loadCompletion(); return; }
    this.schemaSel.style.display = '';
    const list = await api.meta.schemas(c.id, this.db);
    if (!this.schema || !list.includes(this.schema)) this.schema = list[0] || null;
    this.schemaSel.append(list.map((s) => h('option', { value: s, selected: s === this.schema }, s)));
    this.loadCompletion();
  }
  async loadCompletion() {
    const c = this.conn;
    if (!c) return;
    const schema = this.schema || 'main';
    try {
      const objs = await api.meta.objects(c.id, this.db, schema);
      const map = {};
      for (const o of objs) map[o.name] = [];
      this.ed.setLang(this.lang, map, schema);
      // columns for completion, a few tables at a time (they are cached after the first load)
      for (const o of objs.slice(0, 80)) {
        const cols = await api.meta.columns(c.id, this.db, schema, o.name).catch(() => []);
        map[o.name] = cols.map((x) => ({ label: x.name, detail: x.type, type: 'property' }));
      }
      if (this.conn === c) this.ed.setLang(this.lang, map, schema);
    } catch { /* completion is optional */ }
  }

  // ---------- running ----------
  target() {
    const sel = this.ed.selection();
    const text = this.ed.text;
    if (sel.text.trim()) return { sql: sel.text.trim(), from: sel.from, to: sel.to };
    if (this.lang === 'mongo') { // the block of lines around the cursor (blank lines separate blocks)
      const lines = text.split('\n');
      let pos = 0; let at = 0;
      for (let i = 0; i < lines.length; i++) { if (sel.head <= pos + lines[i].length) { at = i; break; } pos += lines[i].length + 1; at = i; }
      let a = at; let b = at;
      while (a > 0 && lines[a - 1].trim()) a--;
      while (b < lines.length - 1 && lines[b + 1].trim()) b++;
      const from = lines.slice(0, a).join('\n').length + (a ? 1 : 0);
      const block = lines.slice(a, b + 1).join('\n');
      return block.trim() ? { sql: block.trim(), from, to: from + block.length } : null;
    }
    const s = statementAt(text, sel.head, this.lang);
    return s ? { sql: s.sql.replace(/;\s*$/, ''), from: s.start, to: s.end } : null;
  }
  busy(on) {
    this.running = on;
    this.runBtn.style.display = on ? 'none' : '';
    this.cancelBtn.style.display = on ? '' : 'none';
    this.el.classList.toggle('running', on);
  }
  async run(refresh) {
    if (this.running) return;
    const t = this.target();
    if (!t) { toast('Nothing to run', 'info', 1500); return; }
    if (!this.conn) { app.emit('cmd', 'new-connection'); return; }
    this.ed.mark(t.from, t.to);
    this.busy(true);
    try { await this.exec(t.sql, { refresh, replace: true }); } finally { this.busy(false); setTimeout(() => this.ed.mark(null), 900); }
  }
  async runScript() {
    if (this.running) return;
    if (!this.conn) return;
    const sel = this.ed.selection();
    const text = sel.text.trim() ? sel.text : this.ed.text;
    const stmts = this.lang === 'mongo' ? text.split(/\n\s*\n/).map((s) => ({ sql: s.trim() })).filter((s) => s.sql) : splitStatements(text, this.lang);
    if (!stmts.length) return;
    this.busy(true);
    this.results = [];
    let ok = 0;
    const t0 = performance.now();
    try {
      for (const s of stmts) {
        if (this.stopScript) break;
        const r = await this.exec(s.sql, { quietGrid: true });
        if (!r) break; // stop at the first error
        ok++;
      }
    } finally {
      this.busy(false);
      this.stopScript = false;
      this.logLine('info', `Script: ${ok} of ${stmts.length} statements ran in ${fmtMs(Math.round(performance.now() - t0))}`);
      if (!this.results.length) this.showTab('log'); else this.showTab(this.results[this.results.length - 1].id);
      this.drawResults();
    }
  }
  async exec(sql, { refresh, replace, quietGrid, wrap } = {}) {
    this.runId = uid('r');
    try {
      const r = await api.data.query({ connId: this.connId, db: this.db, schema: this.schema, sql, session: this.session, runId: this.runId, maxRows: this.maxRows, refresh, wrap });
      const res = r.result;
      if (res.columns.length) {
        const entry = this.resultFor(sql, r, replace && !quietGrid);
        if (!quietGrid) { this.showTab(entry.id); this.drawResults(); }
      } else {
        this.logLine('ok', `${res.command || 'OK'}${res.affected != null ? ` · ${fmtNum(res.affected)} row${res.affected === 1 ? '' : 's'} affected` : ''} · ${fmtMs(r.ms)}`, sql);
        if (!quietGrid) { this.showTab('log'); this.drawResults(); }
        if (r.kind === 'write') app.emit('data-changed', this.connId, sql);
      }
      return r;
    } catch (e) {
      this.logLine('error', e.message, sql);
      this.showTab('log');
      this.drawResults();
      return null;
    }
  }
  resultFor(sql, r, replace) {
    // re-running the same statement updates its tab; otherwise the active result tab is reused
    let entry = this.results.find((x) => x.sql === sql);
    if (!entry && replace && this.results.length) entry = this.results.find((x) => x.id === this.active);
    if (!entry) {
      entry = { id: uid('res'), n: (this.counter = (this.counter || 0) + 1) };
      this.results.push(entry);
      if (this.results.length > 12) this.results.shift();
    }
    const local = !r.result.truncated || this.lang === 'mongo';
    entry.sql = sql;
    entry.r = r;
    entry.where = entry.where || '';
    if (!entry.grid || entry.local !== local) {
      entry.local = local;
      entry.grid = new Grid({
        mode: local ? 'local' : 'server', dialect: this.lang,
        onQuery: ({ order, filters }) => this.refilter(entry, { order, filters }),
        loadDistinct: (col, filters) => api.data.distinct({ connId: this.connId, db: this.db, schema: this.schema, sql: entry.sql, col, where: entry.where, filters }),
      });
      entry.grid.onLocalFilter = () => this.drawFoot();
    }
    entry.grid.setData(r.result, { keepState: true });
    entry.title = guessTitle(sql);
    return entry;
  }
  async refilter(entry, { order, filters, where }) {
    if (where != null) entry.where = where;
    entry.order = order ?? entry.order ?? [];
    entry.filters = filters ?? entry.filters ?? [];
    this.busy(true);
    try {
      const r = await api.data.query({ connId: this.connId, db: this.db, schema: this.schema, sql: entry.sql, session: this.session, maxRows: this.maxRows, wrap: { where: entry.where, filters: entry.filters, order: entry.order } });
      entry.r = r;
      entry.grid.setData(r.result, { keepState: true });
      entry.grid.setState({ order: entry.order, filters: entry.filters });
      entry.error = null;
    } catch (e) { entry.error = e.message; }
    this.busy(false);
    this.drawFoot();
  }
  async explain(analyze) {
    if (this.running || !this.conn) return;
    const t = this.target();
    if (!t) return;
    this.ed.mark(t.from, t.to);
    this.busy(true);
    try {
      const res = await api.data.explain({ connId: this.connId, db: this.db, schema: this.schema, sql: t.sql, analyze });
      this.plan = { sql: t.sql, res };
      this.showTab('plan');
    } catch (e) { this.logLine('error', e.message, t.sql); this.showTab('log'); }
    finally { this.busy(false); this.drawResults(); setTimeout(() => this.ed.mark(null), 900); }
  }
  async cancel() {
    this.stopScript = true;
    await api.data.cancel(this.connId, this.runId).catch(() => {});
  }
  logLine(kind, text, sql) {
    this.log.unshift({ kind, text, sql, at: new Date() });
    if (this.log.length > 300) this.log.pop();
  }

  // ---------- results panel ----------
  showTab(id) { this.active = id; }
  drawResults() {
    clear(this.resTabs);
    for (const r of this.results) {
      this.resTabs.append(h('button', { class: 'res-tab' + (this.active === r.id ? ' on' : ''), title: r.sql, onclick: () => { this.showTab(r.id); this.drawResults(); } },
        icon('table'), h('span', {}, r.title || `Result ${r.n}`), h('span', { class: 'res-n' }, fmtNum(r.r.result.rows.length)),
        h('span', { class: 'res-x', title: 'Close', onclick: (e) => { e.stopPropagation(); this.results = this.results.filter((x) => x !== r); if (this.active === r.id) this.active = this.results[this.results.length - 1]?.id || 'log'; this.drawResults(); } }, icon('x'))));
    }
    if (this.plan) this.resTabs.append(h('button', { class: 'res-tab' + (this.active === 'plan' ? ' on' : ''), onclick: () => { this.showTab('plan'); this.drawResults(); } }, icon('plan'), 'Plan'));
    const errs = this.log.filter((l) => l.kind === 'error').length;
    this.resTabs.append(h('button', { class: 'res-tab' + (this.active === 'log' ? ' on' : ''), onclick: () => { this.showTab('log'); this.drawResults(); } }, icon('terminal'), 'Output', errs && this.log[0]?.kind === 'error' ? h('span', { class: 'res-err' }, '!') : null));
    clear(this.resBody);
    const cur = this.results.find((r) => r.id === this.active);
    if (cur) {
      const sqlDialect = this.lang !== 'mongo';
      const where = h('input', { class: 'input mono filter-input', value: cur.where || '', spellcheck: false, placeholder: 'Enter a SQL expression to filter these results — Enter to apply', onkeydown: (e) => { if (e.key === 'Enter') this.refilter(cur, { where: where.value.trim() }); } });
      this.resBody.append(sqlDialect ? h('div', { class: 'filter-bar' }, h('span', { class: 'filter-lbl' }, 'WHERE'), where,
        h('button', { class: 'icon-btn', title: 'Apply', onclick: () => this.refilter(cur, { where: where.value.trim() }) }, icon('play')),
        h('button', { class: 'icon-btn', title: 'Clear filters', onclick: () => { where.value = ''; cur.grid.setState({ filters: [] }); cur.grid.applyFilters([]); this.refilter(cur, { where: '', filters: [] }); } }, icon('x')),
        h('span', { class: 'tb-sep' }),
        h('button', { class: 'icon-btn', title: 'Record panel', onclick: () => cur.grid.toggleRecord() }, icon('rows')),
        h('button', { class: 'icon-btn', title: 'Export…', onclick: (e) => this.exportMenu(e, cur) }, icon('upload'))) : null, cur.grid.el);
    } else if (this.active === 'plan' && this.plan) {
      this.resBody.append(planView(this.plan.res, { onRerun: (an) => this.explainAgain(an) }));
    } else {
      const box = h('div', { class: 'log' });
      if (!this.log.length) box.append(h('div', { class: 'muted log-empty' }, 'Run a statement with ⌘↵ — or the whole script with ⇧⌘↵.'));
      for (const l of this.log) box.append(h('div', { class: 'log-line ' + l.kind }, h('span', { class: 'log-t' }, l.at.toLocaleTimeString('en-GB')), icon(l.kind === 'error' ? 'warning' : l.kind === 'ok' ? 'check' : 'info'), h('div', { class: 'log-m' }, h('div', {}, l.text), l.sql ? h('div', { class: 'log-sql mono' }, l.sql.length > 300 ? l.sql.slice(0, 300) + '…' : l.sql) : null)));
      this.resBody.append(box);
    }
    this.drawFoot();
  }
  async explainAgain(analyze) {
    if (!this.plan) return;
    this.busy(true);
    try { this.plan.res = await api.data.explain({ connId: this.connId, db: this.db, schema: this.schema, sql: this.plan.sql, analyze }); } catch (e) { toast(e.message, 'error'); }
    this.busy(false);
    this.drawResults();
  }
  drawFoot() {
    clear(this.resFoot);
    const cur = this.results.find((r) => r.id === this.active);
    if (!cur) return;
    if (cur.error) { this.resFoot.append(h('span', { class: 'err-text' }, icon('warning'), cur.error)); return; }
    const r = cur.r;
    const shown = cur.grid.view.length;
    const total = r.result.rows.length;
    this.resFoot.append(
      h('span', {}, h('b', {}, fmtNum(shown)), shown !== total ? ` of ${fmtNum(total)}` : '', ' rows'),
      r.result.truncated ? h('span', { class: 'chip warn', title: 'Raise the row limit in the toolbar to fetch more' }, `first ${fmtNum(this.maxRows)} rows`) : null,
      h('span', { class: 'muted' }, r.cached ? '' : fmtMs(r.ms)),
      r.cached ? h('button', { class: 'chip cache-chip', title: 'Served from Pelican\'s cache — click to run it again (⌘R)', onclick: () => this.rerun(cur) }, icon('zap'), `cached ${ago(r.cached.at)}`, icon('refresh')) : null,
      h('span', { class: 'grow' }),
      h('span', { class: 'muted mono sql-peek', title: cur.sql }, cur.sql.replace(/\s+/g, ' ')));
  }
  async rerun(cur) {
    this.busy(true);
    try { await this.exec(cur.sql, { refresh: true, replace: true }); } finally { this.busy(false); }
  }
  exportMenu(e, cur) {
    const save = async (fmt, ext) => {
      const p = await api.file.save({ name: `${(cur.title || 'result').replace(/[^\w.-]+/g, '_')}.${ext}`, content: cur.grid.exportText(fmt), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (p) toast(`Saved ${p.split('/').pop()}`, 'ok');
    };
    contextMenu({ anchor: e.currentTarget }, [{ header: `Export ${fmtNum(cur.grid.view.length)} rows` }, { label: 'CSV', onClick: () => save('csv', 'csv') }, { label: 'JSON', onClick: () => save('json', 'json') }, { label: 'Markdown table', onClick: () => save('md', 'md') }]);
  }

  command(cmd) {
    if (cmd === 'run') { this.run(); return true; }
    if (cmd === 'run-script') { this.runScript(); return true; }
    if (cmd === 'explain') { this.explain(false); return true; }
    if (cmd === 'explain-analyze') { this.explain(true); return true; }
    if (cmd === 'cancel') { this.cancel(); return true; }
    if (cmd === 'refresh') { const cur = this.results.find((r) => r.id === this.active); if (cur) this.rerun(cur); else this.run(true); return true; }
    return false;
  }
  focus() { this.ed.focus(); }
  insert(text) { this.ed.insert(text); }
  setFontSize(n) { this.ed.setFontSize(n); }
  destroy() { if (this.connId) api.data.endSession(this.connId, this.session).catch(() => {}); this.ed.destroy(); }
  key() { return 'editor:' + this.id; }
}

function guessTitle(sql) {
  const m = /\bfrom\s+([`"[]?[\w.$]+[`"\]]?(?:\.[`"[]?[\w$]+[`"\]]?)?)/i.exec(sql) || /db\.(?:getCollection\(["']([^"']+)["']\)|(\w+))\./.exec(sql);
  if (!m) return null;
  return (m[1] || m[2] || '').replace(/[`"[\]]/g, '').split('.').pop();
}
