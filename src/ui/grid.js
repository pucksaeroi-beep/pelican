// The result grid: virtual rows (fast with tens of thousands of rows), resizable columns, sorting,
// a filter popover per column (distinct values with counts + a condition), cell selection, copy,
// and a record panel that shows the current row vertically.
//
// mode 'server': sorting / filtering are handed to the owner (onQuery), who reloads rows from the database.
// mode 'local' : everything happens on the rows already loaded.
import { h, icon, clear, fmtNum } from './h.js';
import { contextMenu, popover, toast } from './overlay.js';

const ROW_H = 26;
const OVERSCAN = 12;
const NUM_TYPES = /^(int|integer|int2|int4|int8|smallint|bigint|tinyint|mediumint|serial|bigserial|numeric|decimal|float|float4|float8|double|real|money|long|longlong|short|tiny|int24|newdecimal|number|decfloat|oid)/i;
const OPS = [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['starts', 'starts with'], ['null', 'is NULL'], ['notnull', 'is not NULL']];

export function typeIcon(type) {
  const t = String(type || '').toLowerCase();
  if (NUM_TYPES.test(t)) return 'hash';
  if (/bool|bit|toggle/.test(t)) return 'toggle';
  if (/date|time|year|interval/.test(t)) return 'calendar';
  if (/json|object|array|xml|document/.test(t)) return 'braces';
  if (/bytea|blob|binary|varbinary/.test(t)) return 'binary';
  if (/objectid|uuid/.test(t)) return 'key';
  return 'type';
}
export function display(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export class Grid {
  constructor({ mode = 'local', onQuery, loadDistinct, onOpenRow, tableName, dialect, emptyText = 'No rows' } = {}) {
    this.mode = mode;
    this.onQuery = onQuery;
    this.loadDistinct = loadDistinct;
    this.tableName = tableName;
    this.dialect = dialect;
    this.emptyText = emptyText;
    this.columns = [];
    this.rows = [];
    this.view = []; // indexes into rows (local filter / sort)
    this.order = [];
    this.filters = [];
    this.widths = [];
    this.sel = null; // { r, c, r2, c2 } in view coordinates
    this.recordOpen = false;

    this.el = h('div', { class: 'grid', tabindex: '0' });
    this.scroller = h('div', { class: 'g-scroll' });
    this.head = h('div', { class: 'g-head' });
    this.body = h('div', { class: 'g-body' });
    this.empty = h('div', { class: 'g-empty' });
    this.record = h('div', { class: 'g-record' });
    this.scroller.append(this.head, this.body);
    this.el.append(this.scroller, this.empty, this.record);
    this.scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.body.addEventListener('mousedown', (e) => this.mouse(e));
    this.body.addEventListener('dblclick', (e) => { const p = this.cellAt(e); if (p) { this.sel = { r: p.r, c: p.c, r2: p.r, c2: p.c }; this.toggleRecord(true); } });
    this.body.addEventListener('contextmenu', (e) => this.cellMenu(e));
  }

  setData({ columns, rows }, { keepState = false } = {}) {
    const sameCols = keepState && this.columns.length === columns.length && this.columns.every((c, i) => c.name === columns[i].name);
    this.columns = columns;
    this.rows = rows;
    if (!sameCols) { this.widths = this.measure(); if (!keepState) { this.order = []; this.filters = []; } this.sel = null; }
    this.recompute();
    this.renderHead();
    this.render(true);
  }
  appendRows(rows) { this.rows.push(...rows); this.recompute(); this.render(true); }
  setState({ order, filters }) { if (order) this.order = order; if (filters) this.filters = filters; this.renderHead(); }

  measure() {
    const sample = this.rows.slice(0, 120);
    return this.columns.map((c, i) => {
      let w = Math.max(c.name.length * 7.4 + 64, 70);
      for (const r of sample) { const s = display(r[i]); if (s) w = Math.max(w, Math.min(s.length, 60) * 7 + 22); }
      return Math.min(Math.round(w), 380);
    });
  }

  recompute() {
    let idx = this.rows.map((_, i) => i);
    if (this.mode === 'local') {
      for (const f of this.filters) {
        const ci = this.columns.findIndex((c) => c.name === f.col);
        if (ci < 0) continue;
        idx = idx.filter((i) => matchLocal(this.rows[i][ci], f));
      }
      if (this.order.length) {
        const keys = this.order.map((o) => ({ ci: this.columns.findIndex((c) => c.name === o.col), dir: o.dir === 'desc' ? -1 : 1 })).filter((k) => k.ci >= 0);
        idx.sort((a, b) => { for (const k of keys) { const d = cmp(this.rows[a][k.ci], this.rows[b][k.ci]); if (d) return d * k.dir; } return a - b; });
      }
    }
    this.view = idx;
  }

  // ---------- header ----------
  renderHead() {
    clear(this.head);
    const total = this.widths.reduce((a, b) => a + b, 0) + 52;
    this.head.style.width = this.body.style.width = total + 'px';
    this.head.append(h('div', { class: 'g-hcell g-rn', title: 'Select all', onclick: () => { this.sel = { r: 0, c: 0, r2: this.view.length - 1, c2: this.columns.length - 1 }; this.render(true); } }));
    this.columns.forEach((c, i) => {
      const sort = this.order.findIndex((o) => o.col === c.name);
      const filtered = this.filters.some((f) => f.col === c.name);
      const fbtn = h('button', { class: 'g-fbtn' + (filtered ? ' on' : ''), title: 'Filter this column', onclick: (e) => { e.stopPropagation(); this.filterPopover(i, fbtn); } }, icon(filtered ? 'filterOn' : 'filter'));
      const cell = h('div', { class: 'g-hcell' + (sort >= 0 ? ' sorted' : ''), style: { width: this.widths[i] + 'px' }, title: `${c.name}${c.type ? ' · ' + c.type : ''}\nClick to sort, ⇧-click to add a sort` },
        icon(typeIcon(c.type), 'g-tic'),
        h('span', { class: 'g-hname' }, c.name),
        sort >= 0 ? h('span', { class: 'g-sort' }, icon(this.order[sort].dir === 'desc' ? 'sortDesc' : 'sortAsc'), this.order.length > 1 ? String(sort + 1) : null) : null,
        fbtn,
        h('div', { class: 'g-rsz' }));
      cell.addEventListener('click', (e) => { if (!e.target.closest('.g-rsz')) this.toggleSort(c.name, e.shiftKey); });
      cell.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Sort ascending', icon: 'sortAsc', onClick: () => this.applySort([{ col: c.name, dir: 'asc' }]) },
        { label: 'Sort descending', icon: 'sortDesc', onClick: () => this.applySort([{ col: c.name, dir: 'desc' }]) },
        { label: 'Filter…', icon: 'filter', onClick: () => this.filterPopover(i, fbtn) },
        filtered ? { label: 'Clear filter', onClick: () => this.applyFilters(this.filters.filter((f) => f.col !== c.name)) } : null,
        '-',
        { label: 'Copy column name', icon: 'copy', onClick: () => copy(c.name) },
        { label: 'Copy column values', onClick: () => copy(this.view.map((r) => display(this.rows[r][i]) ?? '').join('\n')) },
        { label: 'Fit width', onClick: () => { this.widths[i] = this.measure()[i]; this.renderHead(); this.render(true); } },
      ]));
      const rsz = cell.querySelector('.g-rsz');
      rsz.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const x0 = e.clientX; const w0 = this.widths[i];
        rsz.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing-x');
        const mv = (ev) => { this.widths[i] = Math.max(48, w0 + ev.clientX - x0); cell.style.width = this.widths[i] + 'px'; this.render(true); this.head.style.width = this.body.style.width = this.widths.reduce((a, b) => a + b, 0) + 52 + 'px'; };
        const up = () => { rsz.removeEventListener('pointermove', mv); rsz.removeEventListener('pointerup', up); document.body.classList.remove('resizing-x'); };
        rsz.addEventListener('pointermove', mv);
        rsz.addEventListener('pointerup', up);
      });
      rsz.addEventListener('dblclick', (e) => { e.stopPropagation(); this.widths[i] = this.measure()[i]; this.renderHead(); this.render(true); });
      this.head.append(cell);
    });
  }
  toggleSort(col, add) {
    const cur = this.order.find((o) => o.col === col);
    let next;
    if (!cur) next = add ? [...this.order, { col, dir: 'asc' }] : [{ col, dir: 'asc' }];
    else if (cur.dir === 'asc') next = (add ? this.order : [cur]).map((o) => (o.col === col ? { col, dir: 'desc' } : o));
    else next = add ? this.order.filter((o) => o.col !== col) : [];
    this.applySort(next);
  }
  applySort(order) {
    this.order = order;
    this.renderHead();
    if (this.mode === 'server') this.onQuery?.({ order: this.order, filters: this.filters });
    else { this.recompute(); this.render(true); }
  }
  applyFilters(filters) {
    this.filters = filters;
    this.renderHead();
    if (this.mode === 'server') this.onQuery?.({ order: this.order, filters: this.filters });
    else { this.recompute(); this.render(true); this.onLocalFilter?.(this.view.length); }
  }

  async filterPopover(ci, anchor) {
    const col = this.columns[ci];
    const existing = this.filters.find((f) => f.col === col.name);
    const list = h('div', { class: 'fp-list' }, h('div', { class: 'fp-loading muted' }, 'Loading values…'));
    const search = h('input', { class: 'input sm', placeholder: 'Search values', spellcheck: false });
    const opSel = h('select', { class: 'input sm fp-op' }, h('option', { value: '' }, 'Condition…'), OPS.map(([k, l]) => h('option', { value: k, selected: existing && existing.op === k }, l)));
    const opVal = h('input', { class: 'input sm', placeholder: 'value', value: existing && OPS.some(([k]) => k === existing.op) ? display(existing.values?.[0]) ?? '' : '' });
    const syncOp = () => { opVal.style.display = ['null', 'notnull', ''].includes(opSel.value) ? 'none' : ''; };
    opSel.addEventListener('change', syncOp);
    syncOp();
    let values = [];
    let checks = [];
    const allBox = h('input', { type: 'checkbox' });
    const draw = () => {
      clear(list);
      const q = search.value.toLowerCase();
      checks.forEach((c) => { c.row.style.display = !q || String(c.label).toLowerCase().includes(q) ? '' : 'none'; });
      list.append(h('label', { class: 'fp-item fp-all' }, allBox, h('span', {}, '(Select all)')));
      for (const c of checks) list.append(c.row);
      if (!checks.length) list.append(h('div', { class: 'muted fp-loading' }, 'No values'));
      allBox.checked = checks.every((c) => c.box.checked);
    };
    allBox.addEventListener('change', () => { checks.forEach((c) => { if (c.row.style.display !== 'none') c.box.checked = allBox.checked; }); });
    search.addEventListener('input', draw);
    const apply = () => {
      let rest = this.filters.filter((f) => f.col !== col.name);
      if (opSel.value) rest = [...rest, { col: col.name, op: opSel.value, values: [opVal.value] }];
      else if (checks.length && !checks.every((c) => c.box.checked)) {
        const on = checks.filter((c) => c.box.checked).map((c) => c.v);
        const off = checks.filter((c) => !c.box.checked).map((c) => c.v);
        const complete = !this.distinctTruncated;
        rest = [...rest, complete && off.length < on.length ? { col: col.name, op: 'nin', values: off } : { col: col.name, op: 'in', values: on }];
      }
      pop.close();
      this.applyFilters(rest);
    };
    opVal.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    const pop = popover(anchor, h('div', { class: 'fp' },
      h('div', { class: 'fp-title' }, icon(typeIcon(col.type)), h('b', {}, col.name), h('span', { class: 'muted' }, col.type || '')),
      search, list,
      h('div', { class: 'fp-cond' }, opSel, opVal),
      h('div', { class: 'fp-foot' },
        h('button', { class: 'btn sm', onclick: () => { pop.close(); this.applyFilters(this.filters.filter((f) => f.col !== col.name)); } }, 'Clear'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm primary', onclick: apply }, 'Apply'))), { cls: 'fp-pop' });
    setTimeout(() => search.focus(), 20);
    try {
      if (this.mode === 'server' && this.loadDistinct) values = await this.loadDistinct(col.name, this.filters.filter((f) => f.col !== col.name));
      else values = localDistinct(this.rows, ci, this.filters.filter((f) => f.col !== col.name), this.columns);
    } catch (e) { clear(list).append(h('div', { class: 'fp-loading err' }, e.message)); return; }
    this.distinctTruncated = values.length >= 300;
    const inSet = existing?.op === 'in' ? new Set(existing.values.map(key)) : null;
    const outSet = existing?.op === 'nin' ? new Set(existing.values.map(key)) : null;
    checks = values.map(({ v, n }) => {
      const label = v === null ? 'NULL' : typeof v === 'object' ? (v.$oid || v.$date || JSON.stringify(v)) : String(v);
      const box = h('input', { type: 'checkbox', checked: inSet ? inSet.has(key(v)) : outSet ? !outSet.has(key(v)) : true });
      const row = h('label', { class: 'fp-item' }, box, h('span', { class: 'fp-v' + (v === null ? ' null' : '') }, label === '' ? '(empty)' : label), h('span', { class: 'fp-n' }, fmtNum(n)));
      return { v, n, label, box, row };
    });
    draw();
  }

  // ---------- body ----------
  schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
  render(force) {
    const n = this.view.length;
    this.body.style.height = n * ROW_H + 'px';
    this.empty.textContent = n ? '' : this.rows.length ? 'No rows match the filters' : this.emptyText;
    this.empty.style.display = n || !this.columns.length ? 'none' : '';
    const top = this.scroller.scrollTop;
    const hgt = this.scroller.clientHeight || 600;
    const a = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const b = Math.min(n, Math.ceil((top + hgt) / ROW_H) + OVERSCAN);
    if (!force && a === this.ra && b === this.rb) return;
    this.ra = a; this.rb = b;
    const frag = document.createDocumentFragment();
    const s = this.sel && norm(this.sel);
    for (let r = a; r < b; r++) {
      const ri = this.view[r];
      const row = this.rows[ri];
      const rowEl = h('div', { class: 'g-row' + (r % 2 ? ' odd' : '') + (s && r >= s.r && r <= s.r2 ? ' sel' : ''), style: { top: r * ROW_H + 'px' } });
      rowEl.append(h('div', { class: 'g-cell g-rn' }, String(r + 1)));
      for (let c = 0; c < this.columns.length; c++) {
        const v = row[c];
        const cls = ['g-cell'];
        let text;
        if (v === null) { cls.push('null'); text = 'NULL'; } else if (v === undefined) { cls.push('undef'); text = ''; } else {
          text = typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (typeof v === 'number' || NUM_TYPES.test(this.columns[c].type || '')) cls.push('num');
          else if (typeof v === 'boolean') cls.push('bool');
          else if (text.length && (text[0] === '{' || text[0] === '[') && /json|object|array|braces/.test(this.columns[c].type || 'json')) cls.push('json');
          if (text.length > 300) text = text.slice(0, 300) + '…';
        }
        if (s && r >= s.r && r <= s.r2 && c >= s.c && c <= s.c2) cls.push(r === this.sel.r && c === this.sel.c ? 'cur' : 'in');
        rowEl.append(h('div', { class: cls.join(' '), style: { width: this.widths[c] + 'px' }, dataset: { c } }, text));
      }
      frag.append(rowEl);
    }
    clear(this.body).append(frag);
    if (this.recordOpen) this.renderRecord();
  }
  cellAt(e) {
    const rect = this.body.getBoundingClientRect();
    const r = Math.floor((e.clientY - rect.top) / ROW_H);
    const cell = e.target.closest('.g-cell');
    if (!cell || r < 0 || r >= this.view.length) return null;
    if (cell.classList.contains('g-rn')) return { r, c: -1 };
    return { r, c: +cell.dataset.c };
  }
  mouse(e) {
    if (e.button !== 0) return;
    const p = this.cellAt(e);
    if (!p) return;
    this.el.focus({ preventScroll: true });
    if (p.c === -1) { // row number: select the whole row
      this.sel = e.shiftKey && this.sel ? { ...this.sel, r2: p.r, c: 0, c2: this.columns.length - 1 } : { r: p.r, c: 0, r2: p.r, c2: this.columns.length - 1 };
    } else if (e.shiftKey && this.sel) this.sel = { ...this.sel, r2: p.r, c2: p.c };
    else this.sel = { r: p.r, c: p.c, r2: p.r, c2: p.c };
    this.render(true);
    const move = (ev) => {
      const q = this.cellAt(ev);
      if (q && q.c >= 0 && (q.r !== this.sel.r2 || q.c !== this.sel.c2)) { this.sel = { ...this.sel, r2: q.r, c2: q.c }; this.render(true); }
    };
    const up = () => { this.body.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    this.body.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
  key(e) {
    if (e.target !== this.el) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'c') { e.preventDefault(); this.copySelection('tsv'); return; }
    if (mod && e.key === 'a') { e.preventDefault(); this.sel = { r: 0, c: 0, r2: this.view.length - 1, c2: this.columns.length - 1 }; this.render(true); return; }
    if (!this.sel) return;
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [20, 0], PageUp: [-20, 0], Home: [0, -1e9], End: [0, 1e9] }[e.key];
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleRecord(); return; }
    if (e.key === 'Escape' && this.recordOpen) { this.toggleRecord(false); return; }
    if (!mv) return;
    e.preventDefault();
    const clamp = (v, max) => Math.max(0, Math.min(max, v));
    const r2 = clamp((e.shiftKey ? this.sel.r2 : this.sel.r) + (mod && mv[0] ? mv[0] * 1e9 : mv[0]), this.view.length - 1);
    const c2 = clamp((e.shiftKey ? this.sel.c2 : this.sel.c) + (mod && mv[1] ? mv[1] * 1e9 : mv[1]), this.columns.length - 1);
    this.sel = e.shiftKey ? { ...this.sel, r2, c2 } : { r: r2, c: c2, r2, c2 };
    this.reveal(r2, c2);
    this.render(true);
  }
  reveal(r, c) {
    const top = r * ROW_H; const st = this.scroller.scrollTop; const hh = this.scroller.clientHeight - ROW_H - 2;
    if (top < st) this.scroller.scrollTop = top;
    else if (top > st + hh - ROW_H) this.scroller.scrollTop = top - hh + ROW_H;
    let x = 52; for (let i = 0; i < c; i++) x += this.widths[i];
    const sl = this.scroller.scrollLeft; const w = this.scroller.clientWidth;
    if (x - 52 < sl) this.scroller.scrollLeft = x - 52;
    else if (x + this.widths[c] > sl + w) this.scroller.scrollLeft = x + this.widths[c] - w;
  }

  // ---------- selection, copy, menus ----------
  selected() {
    if (!this.sel) return null;
    const s = norm(this.sel);
    const cols = this.columns.slice(s.c, s.c2 + 1);
    const rows = [];
    for (let r = s.r; r <= s.r2; r++) rows.push(this.rows[this.view[r]].slice(s.c, s.c2 + 1));
    return { cols, rows };
  }
  copySelection(fmt) {
    const s = this.selected();
    if (!s) return;
    copy(format(fmt, s.cols, s.rows, this.tableName, this.dialect));
    toast(`Copied ${s.rows.length} row${s.rows.length > 1 ? 's' : ''} × ${s.cols.length} column${s.cols.length > 1 ? 's' : ''}`, 'ok', 1600);
  }
  exportText(fmt) { return format(fmt, this.columns, this.view.map((i) => this.rows[i]), this.tableName, this.dialect); }
  cellMenu(e) {
    const p = this.cellAt(e);
    if (!p) return;
    if (!this.sel || !inSel(this.sel, p.r, Math.max(0, p.c))) { this.sel = { r: p.r, c: Math.max(0, p.c), r2: p.r, c2: p.c < 0 ? this.columns.length - 1 : p.c }; this.render(true); }
    const col = this.columns[Math.max(0, p.c)];
    const v = this.rows[this.view[p.r]][Math.max(0, p.c)];
    const vs = display(v);
    const short = vs == null ? 'NULL' : vs.length > 24 ? vs.slice(0, 24) + '…' : vs;
    contextMenu(e, [
      { label: 'Copy', icon: 'copy', kbd: '⌘C', onClick: () => this.copySelection('tsv') },
      { label: 'Copy with headers', onClick: () => this.copySelection('tsvh') },
      { label: 'Copy as CSV', onClick: () => this.copySelection('csv') },
      { label: 'Copy as JSON', onClick: () => this.copySelection('json') },
      this.tableName ? { label: 'Copy as INSERT', onClick: () => this.copySelection('insert') } : null,
      { label: 'Copy as Markdown', onClick: () => this.copySelection('md') },
      '-',
      { label: `Filter: ${col.name} = ${short}`, icon: 'filter', onClick: () => this.applyFilters([...this.filters.filter((f) => f.col !== col.name), v === null ? { col: col.name, op: 'null', values: [] } : { col: col.name, op: 'in', values: [v] }]) },
      { label: `Filter: ${col.name} ≠ ${short}`, onClick: () => this.applyFilters([...this.filters.filter((f) => f.col !== col.name), v === null ? { col: col.name, op: 'notnull', values: [] } : { col: col.name, op: 'nin', values: [v] }]) },
      this.filters.length ? { label: 'Clear all filters', onClick: () => this.applyFilters([]) } : null,
      '-',
      { label: this.recordOpen ? 'Hide record panel' : 'Show record panel', icon: 'rows', kbd: '↵', onClick: () => this.toggleRecord() },
    ]);
  }
  toggleRecord(force) {
    this.recordOpen = force ?? !this.recordOpen;
    this.el.classList.toggle('with-record', this.recordOpen);
    if (this.recordOpen) this.renderRecord();
  }
  renderRecord() {
    clear(this.record);
    if (!this.sel) { this.record.append(h('div', { class: 'muted rec-empty' }, 'Select a row')); return; }
    const r = this.sel.r2 ?? this.sel.r;
    const row = this.rows[this.view[r]];
    if (!row) return;
    this.record.append(h('div', { class: 'rec-head' }, h('b', {}, `Row ${r + 1}`), h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn', title: 'Copy row as JSON', onclick: () => { copy(JSON.stringify(Object.fromEntries(this.columns.map((c, i) => [c.name, parseMaybe(row[i])])), null, 2)); toast('Copied row as JSON', 'ok', 1400); } }, icon('copy')),
      h('button', { class: 'icon-btn', title: 'Close', onclick: () => this.toggleRecord(false) }, icon('x'))));
    const list = h('div', { class: 'rec-list' });
    this.columns.forEach((c, i) => {
      const v = row[i];
      let text = display(v);
      const pretty = text && (text[0] === '{' || text[0] === '[') ? tryPretty(text) : null;
      list.append(h('div', { class: 'rec-row' + (i === this.sel.c ? ' cur' : '') },
        h('div', { class: 'rec-k' }, icon(typeIcon(c.type), 'g-tic'), h('span', {}, c.name), h('span', { class: 'muted rec-t' }, c.type || '')),
        h('div', { class: 'rec-v' + (v === null ? ' null' : '') + (pretty ? ' json' : ''), ondblclick: () => copy(text ?? '') }, v === null ? 'NULL' : pretty || text)));
    });
    this.record.append(list);
  }
}

// ---------- helpers ----------
function norm(s) { return { r: Math.min(s.r, s.r2), r2: Math.max(s.r, s.r2), c: Math.min(s.c, s.c2), c2: Math.max(s.c, s.c2) }; }
function inSel(s, r, c) { const n = norm(s); return r >= n.r && r <= n.r2 && c >= n.c && c <= n.c2; }
const key = (v) => (v === null ? '\u0000null' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function cmp(a, b) {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const na = typeof a === 'number' ? a : Number(a); const nb = typeof b === 'number' ? b : Number(b);
  if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}
function matchLocal(v, f) {
  const s = v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const x = f.values?.[0];
  switch (f.op) {
    case 'in': return f.values.some((w) => (w === null ? s === null : s === display(w)));
    case 'nin': return !f.values.some((w) => (w === null ? s === null : s === display(w)));
    case 'eq': return s !== null && (cmp(v, x) === 0);
    case 'ne': return s === null || cmp(v, x) !== 0;
    case 'gt': return s !== null && cmp(v, x) > 0;
    case 'gte': return s !== null && cmp(v, x) >= 0;
    case 'lt': return s !== null && cmp(v, x) < 0;
    case 'lte': return s !== null && cmp(v, x) <= 0;
    case 'contains': return s !== null && s.toLowerCase().includes(String(x).toLowerCase());
    case 'starts': return s !== null && s.toLowerCase().startsWith(String(x).toLowerCase());
    case 'null': return s === null;
    case 'notnull': return s !== null;
    default: return true;
  }
}
function localDistinct(rows, ci, otherFilters, columns) {
  const m = new Map();
  for (const r of rows) {
    if (!otherFilters.every((f) => { const i = columns.findIndex((c) => c.name === f.col); return i < 0 || matchLocal(r[i], f); })) continue;
    const v = r[ci] === undefined ? null : r[ci];
    const k = key(v);
    const e = m.get(k);
    if (e) e.n++; else m.set(k, { v, n: 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n || cmp(a.v, b.v)).slice(0, 1000);
}
function tryPretty(t) { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; } }
function parseMaybe(v) { if (typeof v === 'string' && (v[0] === '{' || v[0] === '[')) { try { return JSON.parse(v); } catch { /* text */ } } return v; }
export function copy(text) { window.pelican.clipboard.write(text); }

function csvCell(v) { const s = display(v) ?? ''; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function sqlLit(v, dialect) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = display(v).replace(/'/g, "''");
  if (dialect === 'mysql') s = s.replace(/\\/g, '\\\\');
  return `'${s}'`;
}
export function format(fmt, cols, rows, tableName, dialect) {
  const names = cols.map((c) => c.name);
  if (fmt === 'tsv') return rows.map((r) => r.map((v) => display(v) ?? '').join('\t')).join('\n');
  if (fmt === 'tsvh') return [names.join('\t'), ...rows.map((r) => r.map((v) => display(v) ?? '').join('\t'))].join('\n');
  if (fmt === 'csv') return [names.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
  if (fmt === 'json') return JSON.stringify(rows.map((r) => Object.fromEntries(names.map((n, i) => [n, parseMaybe(r[i])]))), null, 2);
  if (fmt === 'md') {
    const esc = (v) => (display(v) ?? 'NULL').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return [`| ${names.join(' | ')} |`, `| ${names.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
  }
  if (fmt === 'insert') {
    const q = (n) => (dialect === 'mysql' ? '`' + n.replace(/`/g, '``') + '`' : '"' + n.replace(/"/g, '""') + '"');
    return rows.map((r) => `INSERT INTO ${tableName} (${names.map(q).join(', ')}) VALUES (${r.map((v) => sqlLit(v, dialect)).join(', ')});`).join('\n');
  }
  return '';
}
