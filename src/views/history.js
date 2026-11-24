// Query Manager: every statement Pelican ran (you, table views, AI clients over MCP), searchable.
import { h, icon, clear, fmtNum, fmtMs, timeOf, debounce } from '../ui/h.js';
import { contextMenu, confirmBox } from '../ui/overlay.js';
import { app, api } from '../app.js';
import { engineBadge } from './sidebar.js';

const KINDS = [['all', 'All'], ['user', 'Editor'], ['table', 'Table views'], ['mcp', 'AI (MCP)'], ['err', 'Errors']];

export class HistoryPanel {
  constructor() {
    this.items = [];
    this.kind = 'all';
    this.q = '';
    this.search = h('input', { class: 'input sm', placeholder: 'Type part of a query to search the history', spellcheck: false, oninput: debounce(() => { this.q = this.search.value.toLowerCase(); this.render(); }, 120) });
    this.kindsEl = h('div', { class: 'seg' });
    this.list = h('div', { class: 'qm-list' });
    this.count = h('span', { class: 'muted' });
    this.el = h('div', { class: 'dock' },
      h('div', { class: 'dock-head' },
        h('span', { class: 'dock-title' }, icon('history'), 'Query Manager'),
        this.kindsEl, h('div', { class: 'qm-search' }, icon('search'), this.search), this.count, h('span', { class: 'grow' }),
        h('button', { class: 'icon-btn', title: 'Clear history', onclick: async () => { if (await confirmBox({ title: 'Clear the query history?', message: 'Every entry in the Query Manager will be deleted.', ok: 'Clear', danger: true })) { await api.history.clear(); this.items = []; this.render(); } } }, icon('trash')),
        h('button', { class: 'icon-btn', title: 'Hide (⌘J)', onclick: () => app.emit('cmd', 'toggle-history') }, icon('x'))),
      h('div', { class: 'qm-head' }, h('span', { class: 'qm-time' }, 'Time'), h('span', { class: 'qm-type' }, 'Type'), h('span', { class: 'qm-text' }, 'Text'), h('span', { class: 'qm-num' }, 'Duration'), h('span', { class: 'qm-num' }, 'Rows'), h('span', { class: 'qm-res' }, 'Result'), h('span', { class: 'qm-conn' }, 'Connection')),
      this.list);
    api.on.history((e) => { this.items.push(e); if (this.items.length > 2000) this.items.shift(); this.scheduleRender(); });
    this.load();
  }
  async load() { this.items = await api.history.list(); this.render(); }
  scheduleRender() { if (!this.t) this.t = setTimeout(() => { this.t = null; this.render(); }, 150); }
  render() {
    clear(this.kindsEl).append(KINDS.map(([k, l]) => h('button', { class: this.kind === k ? 'on' : '', onclick: () => { this.kind = k; this.render(); } }, l)));
    const q = this.q;
    const items = [];
    for (let i = this.items.length - 1; i >= 0 && items.length < 600; i--) {
      const e = this.items[i];
      if (this.kind === 'err' ? e.result === 'ok' : this.kind !== 'all' && e.type !== this.kind) continue;
      if (q && !(e.sql || '').toLowerCase().includes(q) && !(e.connName || '').toLowerCase().includes(q)) continue;
      items.push(e);
    }
    this.count.textContent = `${fmtNum(items.length)}${items.length === 600 ? '+' : ''} entries`;
    clear(this.list);
    const frag = document.createDocumentFragment();
    for (const e of items) {
      const ok = e.result === 'ok';
      const row = h('div', { class: 'qm-row' + (ok ? '' : ' err'), title: e.sql },
        h('span', { class: 'qm-time' }, timeOf(e.time)),
        h('span', { class: 'qm-type' }, h('span', { class: 'tag ' + e.type }, { user: 'SQL', table: 'Table', mcp: 'AI' }[e.type] || e.type)),
        h('span', { class: 'qm-text mono' }, (e.sql || '').replace(/\s+/g, ' ').slice(0, 400)),
        h('span', { class: 'qm-num' }, fmtMs(e.ms)),
        h('span', { class: 'qm-num' }, e.rows != null ? fmtNum(e.rows) : ''),
        h('span', { class: 'qm-res' + (ok ? ' ok' : '') }, ok ? 'Success' : e.result),
        h('span', { class: 'qm-conn' }, e.connType ? engineBadge(e.connType, 'xs') : null, e.connName || ''));
      row.addEventListener('dblclick', () => app.emit('open-editor', { connId: e.connId, db: e.db, schema: e.schema, text: e.sql }));
      row.addEventListener('contextmenu', (ev) => contextMenu(ev, [
        { label: 'Open in new editor', icon: 'code', onClick: () => app.emit('open-editor', { connId: e.connId, db: e.db, schema: e.schema, text: e.sql }) },
        { label: 'Run again in new editor', icon: 'play', onClick: () => app.emit('open-editor', { connId: e.connId, db: e.db, schema: e.schema, text: e.sql, run: true }) },
        { label: 'Insert into current editor', onClick: () => app.emit('insert-text', e.sql) },
        '-',
        { label: 'Copy query', icon: 'copy', onClick: () => api.clipboard.write(e.sql || '') },
        !ok ? { label: 'Copy error', onClick: () => api.clipboard.write(e.result || '') } : null,
      ]));
      frag.append(row);
    }
    if (!items.length) frag.append(h('div', { class: 'muted qm-empty' }, this.items.length ? 'Nothing matches' : 'Queries you run appear here'));
    this.list.append(frag);
  }
}
