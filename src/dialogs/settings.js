import { h, icon, clear } from '../ui/h.js';
import { modal, toast } from '../ui/overlay.js';
import { app, api } from '../app.js';

export function settingsDialog() {
  const s = { ...app.state.settings };
  const row = (label, input, hint) => h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-l' }, label), hint ? h('div', { class: 'muted sm' }, hint) : null), input);
  const sw = (k) => { const b = h('button', { class: 'switch' + (s[k] ? ' on' : ''), onclick: async () => { s[k] = !s[k]; b.classList.toggle('on', s[k]); await app.setSettings({ [k]: s[k] }); } }, h('i')); return b; };
  const sel = (k, opts) => { const el = h('select', { class: 'input sm' }, opts.map(([v, l]) => h('option', { value: v, selected: String(s[k]) === String(v) }, l))); el.addEventListener('change', () => app.setSettings({ [k]: isNaN(el.value) ? el.value : +el.value })); return el; };
  const m = modal({
    title: 'Settings', width: 560,
    body: h('div', { class: 'settings' },
      h('div', { class: 'set-group' }, h('div', { class: 'set-h' }, icon('zap'), 'Cache'),
        row('Use cached results', sw('cache'), 'Reopening a table, paging back or re-running a read shows the rows Pelican already fetched. ⌘R or the ↻ chip always fetches fresh rows. Any change you run clears that connection\'s cache.'),
        row('Cached results expire after', sel('cacheTtlMin', [[5, '5 minutes'], [30, '30 minutes'], [120, '2 hours'], [0, 'Never (until refresh)']])),
        row('Clear the cache now', h('button', { class: 'btn sm', onclick: async () => { await api.cache.clear(); toast('Cache cleared', 'ok'); } }, 'Clear'))),
      h('div', { class: 'set-group' }, h('div', { class: 'set-h' }, icon('table'), 'Data'),
        row('Rows per page in table views', sel('pageSize', [[100, '100'], [200, '200'], [500, '500'], [1000, '1,000']])),
        row('Default row limit in the SQL editor', sel('editorMaxRows', [[100, '100'], [500, '500'], [1000, '1,000'], [5000, '5,000'], [20000, '20,000']])),
        row('Show system schemas', sw('showSystem'), 'pg_catalog, information_schema, mysql, SYS…')),
      networkGroup(row),
      h('div', { class: 'set-group' }, h('div', { class: 'set-h' }, icon('eye'), 'Appearance'),
        row('Theme', sel('theme', [['system', 'Match macOS'], ['light', 'Light'], ['dark', 'Dark']])),
        row('Editor font size', sel('fontSize', [[11, '11'], [12, '12'], [13, '13'], [14, '14'], [15, '15'], [16, '16']])))),
    foot: [h('span', { class: 'muted sm' }, `Pelican ${app.state.version}`), h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')],
  });
  return m;
}

export const DEFAULT_NO_PROXY = 'localhost, 127.0.0.1, ::1, *.local';

/** Settings → Network: the proxy every connection uses unless it picks its own. */
function networkGroup(row) {
  const p = { mode: 'none', url: '', noProxy: DEFAULT_NO_PROXY, user: '', pass: '', ...(app.state.settings.proxy || {}) };
  const body = h('div', {});
  const save = async () => {
    try { await app.setSettings({ proxy: { ...p } }); } catch (e) { toast(e.message, 'error', 6000); }
  };
  const input = (k, { mono, ...attrs } = {}) => {
    const el = h('input', { class: 'input sm' + (mono ? ' mono' : ''), value: p[k] || '', spellcheck: false, autocomplete: 'off', ...attrs });
    el.addEventListener('change', () => { p[k] = el.value.trim(); save(); });
    return el;
  };
  function draw() {
    clear(body);
    const mode = h('select', { class: 'input sm' }, [['none', 'No proxy'], ['system', 'Match macOS'], ['custom', 'Custom proxy']].map(([v, l]) => h('option', { value: v, selected: p.mode === v }, l)));
    mode.addEventListener('change', () => { p.mode = mode.value; save(); draw(); });
    body.append(row('Proxy for database connections', mode,
      { none: 'Connections go straight to the server.', system: 'Uses System Settings → Network → Proxies (including PAC files). Hosts that macOS sends direct stay direct.', custom: 'HTTP (CONNECT), HTTPS or SOCKS5 proxy. Each connection can still choose “No proxy” or its own proxy.' }[p.mode]));
    if (p.mode === 'custom') body.append(row('Proxy address', input('url', { mono: true, placeholder: 'socks5://127.0.0.1:1080', style: { width: '230px' } }), 'http://host:port, https://host:port or socks5://host:port'));
    if (p.mode !== 'none') {
      body.append(
        row('Proxy sign-in', h('div', { class: 'inline-2' }, input('user', { placeholder: 'user (optional)', style: { width: '110px' } }), input('pass', { type: 'password', placeholder: 'password', style: { width: '110px' } })), 'Only if the proxy asks. Stored as plain text on this Mac.'),
        row('No proxy for', input('noProxy', { mono: true, style: { width: '230px' } }), 'Comma separated: hosts, *.domain, .domain, IPs, 10.0.0.0/8, host:port'),
      );
    }
    body.append(h('div', { class: 'muted sm set-note' }, icon('info'), ' Applies the next time a connection opens. SQLite files never use the proxy.'));
  }
  draw();
  return h('div', { class: 'set-group' }, h('div', { class: 'set-h' }, icon('globe'), 'Network'), body);
}
