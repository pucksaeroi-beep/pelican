// AI access: Pelican's MCP server and what each connection lets AI clients do.
import { h, icon, clear, fmtMs, debounce } from '../ui/h.js';
import { modal, toast } from '../ui/overlay.js';
import { app, api } from '../app.js';
import { engineBadge } from '../views/sidebar.js';

const ACCESS = [['off', 'Off'], ['read', 'Read only'], ['write', 'Read & write']];

export function mcpDialog(pre = {}) {
  let m = app.state.mcp;
  let sel = pre.connId || app.state.connections.find((c) => (m.policies?.[c.id]?.access || 'off') !== 'off')?.id || app.state.connections[0]?.id;
  let showToken = false;
  let clientTab = 'code';

  const head = h('div', { class: 'mcp-head' });
  const connList = h('div', { class: 'mcp-conns' });
  const editor = h('div', { class: 'mcp-policy' });
  const activity = h('div', { class: 'mcp-activity' });

  const pol = (id) => ({ access: 'off', scope: 'all', allow: {}, maxRows: 500, confirmWrites: true, ...(m.policies?.[id] || {}) });
  async function setPolicy(id, value) {
    m = await api.mcp.set({ policy: { id, value } });
    app.state.mcp = m;
    app.emit('mcp', m);
    drawConns(); drawHead();
  }
  async function set(patch) {
    try { m = await api.mcp.set(patch); } catch (e) { toast(e.message, 'error'); }
    app.state.mcp = m;
    app.emit('mcp', m);
    drawHead(); drawConns();
  }

  function drawHead() {
    clear(head);
    const sw = h('button', { class: 'switch' + (m.enabled ? ' on' : ''), role: 'switch', 'aria-checked': String(!!m.enabled), onclick: () => set({ enabled: !m.enabled }) }, h('i'));
    const port = h('input', { class: 'input sm mono port-in', value: m.port, type: 'number', min: 1024, max: 65535 });
    port.addEventListener('change', () => set({ port: +port.value }));
    const shared = app.state.connections.filter((c) => (m.policies?.[c.id]?.access || 'off') !== 'off').length;
    const token = h('code', { class: 'token' }, showToken ? m.token : '•'.repeat(18));
    head.append(
      h('div', { class: 'mcp-server' }, sw, h('div', {},
        h('div', { class: 'mcp-state' }, m.enabled && m.running ? h('span', { class: 'dot on' }) : h('span', { class: 'dot' }), m.enabled && m.running ? 'MCP server running' : 'MCP server off', h('span', { class: 'muted' }, ` · ${shared} connection${shared === 1 ? '' : 's'} shared`)),
        h('div', { class: 'muted mono sm' }, m.url))),
      h('span', { class: 'grow' }),
      h('label', { class: 'inline' }, h('span', { class: 'muted' }, 'Port'), port),
      h('div', { class: 'inline token-box' }, h('span', { class: 'muted' }, 'Token'), token,
        h('button', { class: 'icon-btn', title: showToken ? 'Hide' : 'Show', onclick: () => { showToken = !showToken; drawHead(); } }, icon('eye')),
        h('button', { class: 'icon-btn', title: 'New token (AI clients must be set up again)', onclick: () => set({ regenerateToken: true }) }, icon('refresh'))));
    const url = m.url;
    const cmd = clientTab === 'code'
      ? `claude mcp add --transport http pelican ${url} --header "Authorization: Bearer ${m.token}"`
      : JSON.stringify({ mcpServers: { pelican: { type: 'http', url, headers: { Authorization: `Bearer ${m.token}` } } } }, null, 2);
    const shown = showToken ? cmd : cmd.split(m.token).join('•'.repeat(10));
    head.append(h('div', { class: 'mcp-client' },
      h('div', { class: 'seg sm' }, [['code', 'Claude Code'], ['json', 'Other clients (JSON)']].map(([k, l]) => h('button', { class: clientTab === k ? 'on' : '', onclick: () => { clientTab = k; drawHead(); } }, l))),
      h('pre', { class: 'mcp-cmd mono' }, shown),
      h('button', { class: 'btn sm', onclick: () => { api.clipboard.write(cmd); toast('Copied — paste it in a terminal', 'ok'); } }, icon('copy'), 'Copy')));
  }

  function drawConns() {
    clear(connList);
    connList.append(h('div', { class: 'mcp-sub' }, 'Connections'));
    for (const c of app.state.connections) {
      const p = pol(c.id);
      connList.append(h('button', { class: 'mcp-conn' + (sel === c.id ? ' on' : ''), onclick: () => { sel = c.id; drawConns(); drawPolicy(); } },
        engineBadge(c.type), h('span', { class: 'ell' }, c.name), h('span', { class: 'grow' }),
        h('span', { class: 'acc ' + p.access }, p.access === 'off' ? 'Off' : p.access === 'read' ? 'Read' : 'Write'), p.access !== 'off' && p.scope === 'custom' ? h('span', { class: 'acc-scope', title: 'Only some schemas / tables' }, icon('filter')) : null));
    }
    if (!app.state.connections.length) connList.append(h('div', { class: 'muted pad' }, 'Add a connection first.'));
  }

  async function drawPolicy() {
    clear(editor);
    const c = app.conn(sel);
    if (!c) return;
    const p = pol(c.id);
    const seg = (items, cur, onPick) => h('div', { class: 'seg' }, items.map(([v, l]) => h('button', { class: cur === v ? 'on' : '', onclick: () => onPick(v) }, l)));
    editor.append(h('div', { class: 'pol-title' }, engineBadge(c.type), h('b', {}, c.name)),
      h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'AI clients can'), seg(ACCESS, p.access, (v) => setPolicy(c.id, { access: v }).then(drawPolicy))));
    const note = {
      off: 'Hidden from AI clients.',
      read: c.type === 'db2' ? 'Only SELECT-style statements (checked before running). For a hard guarantee, use a Db2 user with read-only grants.' : c.type === 'mongo' ? 'find, aggregate (no $out / $merge), count and distinct only.' : `Every query runs inside a read-only ${c.type === 'sqlite' ? 'database handle' : 'transaction'}, so the database itself refuses writes.`,
      write: 'AI clients can also change data and structure with the execute tool.',
    }[p.access];
    editor.append(h('div', { class: 'pol-note ' + p.access }, icon(p.access === 'write' ? 'warning' : p.access === 'read' ? 'shield' : 'lock'), note));
    if (p.access === 'off') return;
    if (p.access === 'write') {
      const cb = h('input', { type: 'checkbox', checked: p.confirmWrites !== false });
      cb.addEventListener('change', () => setPolicy(c.id, { confirmWrites: cb.checked }));
      editor.append(h('label', { class: 'check' }, cb, h('span', {}, 'Ask me before every change'), h('small', { class: 'muted' }, '(a dialog shows the statement)')));
    }
    const mr = h('input', { class: 'input sm mono', type: 'number', min: 1, max: 5000, value: p.maxRows || 500, style: { width: '90px' } });
    mr.addEventListener('change', () => setPolicy(c.id, { maxRows: Math.max(1, Math.min(5000, +mr.value || 500)) }));
    editor.append(h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'Rows per query'), mr, h('span', { class: 'muted sm' }, 'at most')));
    editor.append(h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'Scope'), seg([['all', 'Everything'], ['custom', 'Only what I tick']], p.scope, (v) => setPolicy(c.id, { scope: v }).then(drawPolicy))));
    if (p.scope !== 'custom') return;

    const tree = h('div', { class: 'scope-tree' }, h('div', { class: 'muted pad' }, h('span', { class: 'spin' }), ' Loading schemas…'));
    const q = h('input', { class: 'input sm', placeholder: 'Filter', oninput: debounce(() => draw(), 100) });
    editor.append(h('div', { class: 'scope-tools' }, q, h('span', { class: 'muted sm' }, 'Ticking a schema shares all its tables, including ones created later.')), tree);
    let data = [];
    try {
      await app.connect(c.id);
      const dbs = c.type === 'postgres' ? [c.database || 'postgres'] : [null];
      for (const db of dbs) for (const s of await api.meta.schemas(c.id, db)) data.push({ db, schema: s, objects: null });
      await Promise.all(data.map(async (d) => { d.objects = await api.meta.objects(c.id, d.db, d.schema).catch(() => []); }));
    } catch (e) { clear(tree).append(h('div', { class: 'err-text pad' }, icon('warning'), e.message)); return; }
    const key = (d) => `${d.db || ''}|${d.schema}`;
    function draw() {
      const allow = { ...(pol(c.id).allow || {}) };
      const f = q.value.toLowerCase();
      clear(tree);
      for (const d of data) {
        const k = key(d);
        const entry = allow[k];
        const whole = entry === '*';
        const list = d.objects.filter((o) => !f || o.name.toLowerCase().includes(f) || d.schema.toLowerCase().includes(f));
        if (!list.length && f) continue;
        const sbox = h('input', { type: 'checkbox', checked: whole });
        sbox.indeterminate = Array.isArray(entry) && entry.length > 0;
        sbox.addEventListener('change', () => { const a = { ...pol(c.id).allow }; if (sbox.checked) a[k] = '*'; else delete a[k]; setPolicy(c.id, { allow: a }).then(draw); });
        tree.append(h('label', { class: 'pick-row pick-schema' }, sbox, icon(c.type === 'mysql' || c.type === 'mongo' ? 'database' : 'schema'), h('b', {}, d.schema), h('span', { class: 'muted' }, whole ? 'all tables' : Array.isArray(entry) ? `${entry.length} of ${d.objects.length}` : '')));
        for (const o of list) {
          const on = whole || (Array.isArray(entry) && entry.includes(o.name));
          const box = h('input', { type: 'checkbox', checked: on, disabled: whole });
          box.addEventListener('change', () => {
            const a = { ...pol(c.id).allow };
            const cur = new Set(Array.isArray(a[k]) ? a[k] : []);
            if (box.checked) cur.add(o.name); else cur.delete(o.name);
            if (cur.size) a[k] = [...cur]; else delete a[k];
            setPolicy(c.id, { allow: a }).then(draw);
          });
          tree.append(h('label', { class: 'pick-row pick-table' + (whole ? ' dim' : '') }, box, icon(o.kind === 'view' ? 'view' : c.type === 'mongo' ? 'collection' : 'table'), h('span', {}, o.name)));
        }
      }
    }
    draw();
  }

  async function drawActivity(list) {
    clear(activity).append(h('div', { class: 'mcp-sub' }, 'Recent AI activity'));
    const items = (list || await api.mcp.activity()).slice(-60).reverse();
    if (!items.length) { activity.append(h('div', { class: 'muted pad' }, 'Nothing yet. Calls from AI clients show up here — and in the Query Manager.')); return; }
    for (const e of items) activity.append(h('div', { class: 'act-row' + (e.ok ? '' : e.denied ? ' denied' : ' err'), title: e.error || e.sql || '' },
      h('span', { class: 'muted' }, new Date(e.time).toLocaleTimeString('en-GB')), h('span', { class: 'tag mcp' }, e.tool), h('span', {}, e.connection),
      h('span', { class: 'mono ell' }, e.sql || ''), h('span', { class: e.ok ? 'ok' : 'err-text' }, e.ok ? (e.rows != null ? `${e.rows} rows` : 'ok') : e.denied ? 'denied' : 'error'), h('span', { class: 'muted' }, fmtMs(e.ms))));
  }

  drawHead(); drawConns(); drawPolicy(); drawActivity();
  const offAct = api.on.mcpActivity(() => drawActivity());
  const md = modal({
    title: 'AI access (MCP)', subtitle: 'Let AI clients such as Claude Code use your databases — only the ones you choose, only the way you choose.', width: 940, cls: 'mcp-modal',
    body: h('div', { class: 'mcp' }, head, h('div', { class: 'mcp-main' }, connList, editor), activity),
    foot: [h('span', { class: 'muted sm' }, icon('lock'), ' The server listens on 127.0.0.1 only and needs the token.'), h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => md.close() }, 'Done')],
    onClose: () => offAct(),
  });
  return md;
}
