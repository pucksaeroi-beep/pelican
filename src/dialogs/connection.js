// New / edit connection: pick an engine, or a server Pelican found on this Mac, or paste a URL.
import { h, icon, clear } from '../ui/h.js';
import { ENGINES } from '../ui/icons.js';
import { modal, toast } from '../ui/overlay.js';
import { app, api } from '../app.js';
import { engineBadge } from '../views/sidebar.js';

const COLORS = ['', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
const ORDER = ['postgres', 'mysql', 'sqlite', 'mongo', 'db2'];

export function connectionDialog(existing) {
  const types = app.state.types;
  const c = existing ? { ...existing } : { type: 'postgres', host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', password: '' };
  let nameTouched = !!existing?.name;

  const tiles = h('div', { class: 'eng-tiles' });
  const found = h('div', { class: 'found' });
  const form = h('div', { class: 'conn-form' });
  const status = h('div', { class: 'test-status' });
  const urlIn = h('input', { class: 'input mono', placeholder: 'postgres://user:pass@localhost:5432/db  ·  mysql://…  ·  mongodb://…  ·  /path/to/file.sqlite', spellcheck: false });
  urlIn.addEventListener('paste', () => setTimeout(parse, 0));
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') parse(); });
  async function parse() {
    const p = await api.conn.parseUrl(urlIn.value);
    if (!p) { status.className = 'test-status err'; status.textContent = 'Not a connection URL Pelican understands.'; return; }
    Object.assign(c, p);
    if (!nameTouched) c.name = autoName();
    drawTiles(); drawForm();
    status.className = 'test-status ok'; status.textContent = 'Filled in from the URL.';
  }

  const autoName = () => (c.type === 'sqlite' ? (c.file || '').split('/').pop() || 'SQLite' : `${c.database || ENGINES[c.type].name}${c.host && !/^(localhost|127\.0\.0\.1)$/.test(c.host) ? ' @ ' + c.host : ''}`);
  function setType(t) {
    if (c.type === t) return;
    const d = types[t] || {};
    c.type = t;
    if (t !== 'sqlite') { c.port = d.port; c.user = d.user ?? ''; c.database = d.database ?? ''; c.host = c.host || 'localhost'; }
    if (!nameTouched) c.name = autoName();
    drawTiles(); drawForm();
  }
  function drawTiles() {
    clear(tiles);
    for (const t of ORDER) tiles.append(h('button', { class: 'eng-tile' + (c.type === t ? ' on' : ''), onclick: () => setType(t) }, engineBadge(t, 'lg'), h('span', {}, ENGINES[t].name)));
  }
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
  const text = (k, ph, opts = {}) => {
    const el = h('input', { class: 'input' + (opts.mono ? ' mono' : ''), value: c[k] ?? '', placeholder: ph || '', spellcheck: false, type: opts.type || 'text' });
    el.addEventListener('input', () => { c[k] = opts.type === 'number' ? +el.value : el.value; if (!nameTouched && k !== 'name') nameIn.value = c.name = autoName(); });
    return el;
  };
  const check = (k, label) => { const el = h('input', { type: 'checkbox', checked: !!c[k] }); el.addEventListener('change', () => { c[k] = el.checked; }); return h('label', { class: 'check' }, el, h('span', {}, label)); };
  const sslSel = () => { const s = h('select', { class: 'input' }, [['', 'Off'], ['require', 'Require (don\'t verify)'], ['verify', 'Verify certificate']].map(([v, l]) => h('option', { value: v, selected: (c.ssl || '') === v }, l))); s.addEventListener('change', () => { c.ssl = s.value; }); return s; };
  const nameIn = h('input', { class: 'input', value: c.name || '', placeholder: 'Name in the sidebar' });
  nameIn.addEventListener('input', () => { c.name = nameIn.value; nameTouched = true; });

  function drawForm() {
    clear(form);
    nameIn.value = c.name || autoName();
    c.name = nameIn.value;
    const row = (...kids) => h('div', { class: 'frow' }, kids);
    if (c.type === 'sqlite') {
      const fileIn = text('file', '/path/to/database.sqlite', { mono: true });
      form.append(
        field('Database file', h('div', { class: 'with-btns' }, fileIn,
          h('button', { class: 'btn', onclick: async () => { const p = await api.conn.pickFile({}); if (p) { fileIn.value = c.file = p; if (!nameTouched) nameIn.value = c.name = autoName(); } } }, 'Open…'),
          h('button', { class: 'btn', onclick: async () => { const p = await api.conn.pickFile({ create: true }); if (p) { fileIn.value = c.file = p; if (!nameTouched) nameIn.value = c.name = autoName(); } } }, 'New…'))),
        check('readOnly', 'Open read-only'));
    } else {
      form.append(row(field('Host', text('host', 'localhost')), h('div', { class: 'f-port' }, field('Port', text('port', String(types[c.type]?.port || ''), { type: 'number' })))));
      if (c.type === 'mongo') {
        form.append(row(field('User', text('user', 'optional')), field('Password', text('password', 'optional', { mono: true }))),
          row(field('Auth database', text('authSource', 'admin')), field('Default database', text('database', 'optional'))),
          field('Or a full connection string', text('uri', 'mongodb+srv://…  (overrides the fields above)', { mono: true })));
      } else {
        form.append(row(field('User', text('user', types[c.type]?.user || '')), field('Password', text('password', '', { mono: true }), 'Stored as plain text on this Mac.')),
          row(field(c.type === 'mysql' ? 'Default database' : 'Database', text('database', c.type === 'mysql' ? 'optional' : types[c.type]?.database || '')), field('SSL', sslSel())));
        if (c.type === 'postgres') form.append(check('showAllDatabases', 'Show all databases on this server'));
      }
    }
    const colors = h('div', { class: 'colors' }, COLORS.map((col) => h('button', { class: 'color' + ((c.color || '') === col ? ' on' : '') + (col ? '' : ' none'), style: { background: col || 'transparent' }, title: col ? 'Colour tag (handy for production)' : 'No colour', onclick: (e) => { c.color = col; colors.querySelectorAll('.color').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); } })));
    form.append(row(field('Name', nameIn), field('Colour', colors)));
  }

  async function detect() {
    clear(found).append(h('div', { class: 'muted found-msg' }, h('span', { class: 'spin' }), ' Looking for databases on this Mac…'));
    const list = await api.conn.detect().catch(() => []);
    clear(found);
    if (!list.length) { found.append(h('div', { class: 'muted found-msg' }, 'No local servers found on the usual ports.')); return; }
    found.append(h('div', { class: 'found-title' }, 'Found on this Mac'));
    for (const f of list) {
      const known = app.state.connections.some((x) => x.type === f.type && +x.port === f.port && /^(localhost|127\.0\.0\.1)$/.test(x.host || ''));
      found.append(h('button', { class: 'found-item', onclick: () => { setType(f.type); c.host = 'localhost'; c.port = f.port; if (!nameTouched) c.name = autoName(); drawForm(); urlIn.focus(); } },
        engineBadge(f.type), h('span', {}, ENGINES[f.type].name), h('span', { class: 'muted mono' }, `:${f.port}`), known ? h('span', { class: 'chip' }, 'saved') : null));
    }
  }

  async function test() {
    status.className = 'test-status';
    clear(status).append(h('span', { class: 'spin' }), ' Connecting…');
    try {
      const r = await api.conn.test({ ...c });
      status.className = 'test-status ok';
      clear(status).append(icon('check'), `Connected · ${r.version} · ${r.ms} ms`);
      return true;
    } catch (e) {
      status.className = 'test-status err';
      clear(status).append(icon('warning'), e.message);
      return false;
    }
  }
  async function save(connect) {
    if (c.type === 'sqlite' && !c.file) { status.className = 'test-status err'; status.textContent = 'Choose a database file.'; return; }
    c.name = (nameIn.value || autoName()).trim();
    const saved = await api.conn.save({ ...c, id: existing?.id });
    m.close();
    app.emit('connection-saved', saved, connect);
  }

  drawTiles(); drawForm();
  const m = modal({
    title: existing?.id ? 'Edit connection' : 'New connection', width: 820, cls: 'conn-modal',
    body: h('div', { class: 'conn-layout' },
      h('div', { class: 'conn-left' }, tiles, found),
      h('div', { class: 'conn-right' }, field('Paste a connection URL', urlIn), h('div', { class: 'or' }, h('span', {}, 'or fill in')), form, status)),
    foot: [h('button', { class: 'btn', onclick: test }, icon('plug'), 'Test connection'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => save(true) }, existing?.id ? 'Save' : 'Save & connect')],
  });
  if (!existing?.id) detect();
  else found.append(h('div', { class: 'muted found-msg' }, ''));
  setTimeout(() => (existing ? nameIn : urlIn).focus(), 40);
  return m;
}

export function toastSaved(c) { toast(`Saved “${c.name}”`, 'ok'); }
