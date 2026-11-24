// Execution plan viewer: a tree with cost / time bars, row estimates vs. actual rows, hints for the usual
// suspects (full scans, bad estimates), and every raw property of the node you click.
import { h, icon, clear, fmtNum } from './h.js';
import { copy } from './grid.js';

const n2 = (v) => (v == null || Number.isNaN(v) ? '' : Math.abs(v) >= 100 ? fmtNum(Math.round(v)) : (+v).toFixed(2).replace(/\.?0+$/, ''));

function selfTime(n) { return n.time == null ? null : Math.max(0, n.time - n.children.reduce((a, c) => a + (c.time || 0), 0)); }
function flatten(n, depth = 0, out = [], last = [true]) {
  out.push({ n, depth, last: [...last] });
  n.children.forEach((c, i) => flatten(c, depth + 1, out, [...last, i === n.children.length - 1]));
  return out;
}

export function planView(res, { onRerun } = {}) {
  const wrap = h('div', { class: 'plan' });
  if (res.kind === 'table') { // MariaDB / old MySQL classic EXPLAIN table
    const cols = Object.keys(res.table[0] || {});
    wrap.append(h('table', { class: 'plan-classic' }, h('tr', {}, cols.map((c) => h('th', {}, c))), res.table.map((r) => h('tr', {}, cols.map((c) => h('td', {}, r[c] == null ? '' : String(r[c])))))));
    return wrap;
  }
  const root = res.plan;
  const rows = flatten(root);
  const analyzed = rows.some((r) => r.n.actualRows != null || r.n.time != null);
  const maxCost = Math.max(...rows.map((r) => r.n.cost || 0), 0);
  const total = root.time ?? null;
  const selfs = rows.map((r) => selfTime(r.n));
  const maxSelf = Math.max(...selfs.map((x) => x || 0), 0);

  const detail = h('div', { class: 'plan-detail' });
  const showDetail = (n) => {
    clear(detail).append(h('div', { class: 'pd-title' }, n.label), n.detail ? h('div', { class: 'pd-sub' }, n.detail) : null);
    const t = h('div', { class: 'pd-props' });
    for (const [k, v] of Object.entries(n.props || {})) if (v !== '' && v != null) t.append(h('div', { class: 'pd-k' }, k), h('div', { class: 'pd-v' }, typeof v === 'object' ? JSON.stringify(v) : String(v)));
    detail.append(t);
  };

  const head = h('div', { class: 'plan-row plan-hrow' }, h('div', { class: 'pc-node' }, 'Operation'), h('div', { class: 'pc-num' }, 'Est. rows'),
    analyzed ? h('div', { class: 'pc-num' }, 'Actual rows') : null, analyzed ? h('div', { class: 'pc-num' }, 'Loops') : null,
    h('div', { class: 'pc-num' }, 'Cost'), analyzed ? h('div', { class: 'pc-bar' }, 'Self time') : h('div', { class: 'pc-bar' }, 'Share of cost'));
  const list = h('div', { class: 'plan-list' }, head);
  rows.forEach(({ n, depth, last }, i) => {
    const hints = [];
    if (n.warn || /^Seq Scan|^Table scan|^SCAN$|^COLLSCAN|^TBSCAN/.test(n.label)) if ((n.actualRows ?? n.rows ?? 1000) >= 1000 || n.warn) hints.push(['scan', 'Full scan']);
    if (n.actualRows != null && n.rows != null && n.rows > 0) {
      const ratio = n.actualRows / (n.rows * (n.loops || 1) / (n.loops || 1));
      if (ratio > 10 || ratio < 0.1) hints.push(['est', `Rows off ×${ratio > 1 ? Math.round(ratio) : (1 / ratio).toFixed(0)}`]);
    }
    const self = selfs[i];
    const share = analyzed ? (maxSelf ? (self || 0) / maxSelf : 0) : (maxCost ? (n.cost || 0) / maxCost : 0);
    const guides = h('span', { class: 'pc-guides' });
    for (let d = 1; d <= depth; d++) guides.append(h('span', { class: 'pg' + (d === depth ? (last[d] ? ' end' : ' mid') : last[d] ? ' none' : ' line') }));
    const row = h('div', { class: 'plan-row', tabindex: '0' },
      h('div', { class: 'pc-node' }, guides, h('span', { class: 'pn-label' }, n.label), n.detail ? h('span', { class: 'pn-detail' }, n.detail) : null, hints.map(([k, t]) => h('span', { class: 'pn-hint ' + k }, t))),
      h('div', { class: 'pc-num' }, n2(n.rows)),
      analyzed ? h('div', { class: 'pc-num' }, n2(n.actualRows)) : null,
      analyzed ? h('div', { class: 'pc-num' }, n.loops != null ? fmtNum(n.loops) : '') : null,
      h('div', { class: 'pc-num' }, n2(n.cost)),
      h('div', { class: 'pc-bar' }, h('span', { class: 'bar' }, h('i', { style: { width: Math.max(share * 100, share > 0 ? 2 : 0) + '%' }, class: share > 0.6 ? 'hot' : share > 0.25 ? 'warm' : '' })), h('span', { class: 'bar-t' }, analyzed ? (self != null ? n2(self) + ' ms' : '') : maxCost ? Math.round(share * 100) + '%' : '')));
    row.addEventListener('click', () => { list.querySelectorAll('.plan-row.on').forEach((x) => x.classList.remove('on')); row.classList.add('on'); showDetail(n); });
    list.append(row);
  });

  const props = root.props || {};
  const summary = h('div', { class: 'plan-sum' },
    h('span', { class: 'chip ' + (analyzed ? 'ok' : '') }, analyzed ? 'Analyzed (ran the query)' : 'Estimated plan'),
    root.cost != null ? h('span', {}, 'Total cost ', h('b', {}, n2(root.cost))) : null,
    total != null ? h('span', {}, 'Time ', h('b', {}, n2(total) + ' ms')) : null,
    props['Planning Time'] ? h('span', {}, 'Planning ', h('b', {}, props['Planning Time'])) : null,
    props['Execution Time'] ? h('span', {}, 'Execution ', h('b', {}, props['Execution Time'])) : null,
    props['Execution time'] ? h('span', {}, 'Execution ', h('b', {}, props['Execution time'])) : null,
    props['Docs examined'] != null ? h('span', {}, 'Docs examined ', h('b', {}, fmtNum(props['Docs examined']))) : null,
    h('span', { class: 'grow' }),
    !analyzed && onRerun ? h('button', { class: 'btn sm', onclick: () => onRerun(true) }, icon('play'), 'Analyze') : null,
    h('button', { class: 'btn sm', title: 'Copy the raw plan', onclick: () => copy(res.text || JSON.stringify(res.raw || res.plan, null, 2)) }, icon('copy'), 'Copy raw'));
  wrap.append(summary, h('div', { class: 'plan-split' }, list, detail));
  showDetail(root);
  list.querySelector('.plan-row:not(.plan-hrow)')?.classList.add('on');
  return wrap;
}
