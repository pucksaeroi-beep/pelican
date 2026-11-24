// Dump a database, some schemas or picked tables — structure, data or both.
import { h, icon, clear, fmtNum, fmtBytes, debounce } from '../ui/h.js';
import { modal, toast } from '../ui/overlay.js';
import { app, api } from '../app.js';
import { engineBadge } from '../views/sidebar.js';

export function dumpDialog(pre = {}) {
  const st = {
    connId: pre.connId || app.state.connections[0]?.id, db: pre.db ?? null,
    scope: pre.tables?.length ? 'tables' : pre.schema ? 'schemas' : 'database',
    schemas: new Set(pre.schema ? [pre.schema] : []), tables: new Set((pre.tables || []).map((t) => `${pre.schema}\u0000${t}`)),
    content: 'all', engine: 'auto', dropIfExists: false, noOwner: true, dataFormat: 'insert', pgFormat: 'plain', gzip: false, out: '',
  };
  let objects = new Map(); // schema → [objects]
  let schemaList = [];
  let tools = {};
  const conn = () => app.conn(st.connId);

  const connSel = h('select', { class: 'input' }, app.state.connections.map((c) => h('option', { value: c.id, selected: c.id === st.connId }, c.name)));
  connSel.addEventListener('change', () => { st.connId = connSel.value; st.db = null; st.schemas.clear(); st.tables.clear(); st.out = ''; load(); });
  const dbSel = h('select', { class: 'input' });
  dbSel.addEventListener('change', () => { st.db = dbSel.value; st.schemas.clear(); st.tables.clear(); st.out = ''; loadSchemas(); });
  const scopeEl = h('div', { class: 'seg' });
  const pick = h('div', { class: 'dump-pick' });
  const opts = h('div', { class: 'dump-opts' });
  const toolLine = h('div', { class: 'tool-line' });
  const outIn = h('input', { class: 'input mono', placeholder: 'Choose where to save the dump' });
  outIn.addEventListener('input', () => { st.out = outIn.value; st.outTouched = true; });
  const progress = h('div', { class: 'dump-progress', style: { display: 'none' } });
  const runBtn = h('button', { class: 'btn primary', onclick: () => run() }, icon('download'), 'Start dump');
  const search = h('input', { class: 'input sm', placeholder: 'Filter tables', oninput: debounce(() => drawPick(), 100) });

  const seg = (key, items, onChange) => h('div', { class: 'seg' }, items.map(([v, l]) => h('button', { class: st[key] === v ? 'on' : '', onclick: () => { st[key] = v; onChange?.(); drawOpts(); } }, l)));
  const check = (key, label, hint) => { const el = h('input', { type: 'checkbox', checked: !!st[key] }); el.addEventListener('change', () => { st[key] = el.checked; if (key === 'gzip') suggestOut(true); }); return h('label', { class: 'check' }, el, h('span', {}, label), hint ? h('small', { class: 'muted' }, hint) : null); };

  function ext() {
    const c = conn();
    if (c?.type === 'mongo') return tools.mongodump && st.engine !== 'builtin' ? (st.gzip ? '.archive.gz' : '.archive') : st.gzip ? '.js.gz' : '.js';
    if (c?.type === 'postgres' && st.pgFormat === 'custom') return '.dump';
    return st.gzip ? '.sql.gz' : '.sql';
  }
  function suggestOut(force) {
    if (st.out && st.outTouched && force) { st.out = st.out.replace(/\.(sql\.gz|sql|dump|js\.gz|js|archive\.gz|archive)$/, '') + ext(); outIn.value = st.out; return; }
    if (st.out && !force) return;
    const c = conn();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const what = st.scope === 'tables' && st.tables.size === 1 ? [...st.tables][0].split('\u0000')[1] : st.scope === 'schemas' && st.schemas.size === 1 ? [...st.schemas][0] : st.db || c?.database || c?.name || 'dump';
    const clean = (x) => String(x).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
    const base = `${clean(c?.name || 'db')}-${clean(what)}-${st.content === 'schema' ? 'schema-' : st.content === 'data' ? 'data-' : ''}${stamp}${ext()}`;
    const home = app.state.home || '';
    const dir = (st.out ? st.out.replace(/\/[^/]*$/, '') : (app.state.dumpDir || '~/Downloads')).replace(home && new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=/|$)'), '~');
    st.out = `${dir}/${base}`;
    outIn.value = st.out;
  }

  async function load() {
    const c = conn();
    if (!c) return;
    tools = await api.dump.tools().catch(() => ({}));
    clear(pick).append(h('div', { class: 'muted pad' }, h('span', { class: 'spin' }), ' Loading…'));
    try {
      await app.connect(c.id);
      if (c.type === 'postgres') {
        const dbs = await api.meta.databases(c.id);
        st.db = st.db || c.database || dbs[0];
        clear(dbSel).append(dbs.map((d) => h('option', { value: d, selected: d === st.db }, d)));
        dbSel.parentElement.style.display = dbs.length > 1 ? '' : 'none';
      } else dbSel.parentElement.style.display = 'none';
      await loadSchemas();
    } catch (e) { clear(pick).append(h('div', { class: 'err-text pad' }, icon('warning'), e.message)); }
  }
  async function loadSchemas() {
    const c = conn();
    schemaList = await api.meta.schemas(c.id, st.db);
    objects = new Map();
    if (c.type === 'mongo' || c.type === 'mysql') { if (!st.schemas.size && st.scope === 'database') st.schemas.add(pre.schema || c.database || schemaList[0]); }
    await Promise.all(schemaList.map(async (s) => objects.set(s, await api.meta.objects(c.id, st.db, s).catch(() => []))));
    drawScope(); drawPick(); drawOpts(); suggestOut(true);
  }

  function drawScope() {
    const c = conn();
    const dbWord = c.type === 'mysql' || c.type === 'mongo' ? 'database' : 'schema';
    const items = c.type === 'sqlite' ? [['database', 'Whole database'], ['tables', 'Pick tables']] : c.type === 'mysql' || c.type === 'mongo' ? [['schemas', `Pick ${dbWord}s`], ['tables', 'Pick tables']] : [['database', 'Whole database'], ['schemas', `Pick ${dbWord}s`], ['tables', 'Pick tables']];
    if (!items.some(([v]) => v === st.scope)) st.scope = items[0][0];
    clear(scopeEl).append(items.map(([v, l]) => h('button', { class: st.scope === v ? 'on' : '', onclick: () => { st.scope = v; drawScope(); drawPick(); suggestOut(true); } }, l)));
  }
  function drawPick() {
    clear(pick);
    const c = conn();
    if (st.scope === 'database') {
      const n = [...objects.values()].reduce((a, l) => a + l.length, 0);
      const rows = [...objects.values()].flat().reduce((a, o) => a + (o.rows || 0), 0);
      pick.append(h('div', { class: 'pick-all' }, icon('database'), h('div', {}, h('b', {}, `Everything in ${st.db || c.database || c.file?.split('/').pop() || c.name}`), h('div', { class: 'muted' }, `${schemaList.length} schema${schemaList.length === 1 ? '' : 's'} · ${fmtNum(n)} tables & views${rows ? ` · ≈ ${fmtNum(rows)} rows` : ''}`))));
      return;
    }
    if (st.scope === 'schemas') {
      for (const s of schemaList) {
        const box = h('input', { type: 'checkbox', checked: st.schemas.has(s) });
        box.addEventListener('change', () => { if (box.checked) st.schemas.add(s); else st.schemas.delete(s); suggestOut(true); });
        pick.append(h('label', { class: 'pick-row' }, box, icon(c.type === 'mysql' || c.type === 'mongo' ? 'database' : 'schema'), h('span', {}, s), h('span', { class: 'muted' }, `${(objects.get(s) || []).length} objects`)));
      }
      return;
    }
    const q = search.value.toLowerCase();
    pick.append(h('div', { class: 'pick-tools' }, search, h('button', { class: 'link', onclick: () => { for (const [s, l] of objects) for (const o of l) if (!q || o.name.toLowerCase().includes(q)) st.tables.add(`${s}\u0000${o.name}`); drawPick(); } }, 'Select all'), h('button', { class: 'link', onclick: () => { st.tables.clear(); drawPick(); } }, 'None')));
    for (const s of schemaList) {
      const list = (objects.get(s) || []).filter((o) => !q || o.name.toLowerCase().includes(q));
      if (!list.length) continue;
      if (schemaList.length > 1 || c.type !== 'sqlite') {
        const all = list.every((o) => st.tables.has(`${s}\u0000${o.name}`));
        const sbox = h('input', { type: 'checkbox', checked: all });
        sbox.addEventListener('change', () => { for (const o of list) { const k = `${s}\u0000${o.name}`; if (sbox.checked) st.tables.add(k); else st.tables.delete(k); } drawPick(); });
        pick.append(h('label', { class: 'pick-row pick-schema' }, sbox, icon(c.type === 'mysql' || c.type === 'mongo' ? 'database' : 'schema'), h('b', {}, s)));
      }
      for (const o of list) {
        const k = `${s}\u0000${o.name}`;
        const box = h('input', { type: 'checkbox', checked: st.tables.has(k) });
        box.addEventListener('change', () => { if (box.checked) st.tables.add(k); else st.tables.delete(k); suggestOut(true); });
        pick.append(h('label', { class: 'pick-row pick-table' }, box, icon(o.kind === 'view' ? 'view' : c.type === 'mongo' ? 'collection' : 'table'), h('span', {}, o.name), h('span', { class: 'muted' }, o.rows != null ? `≈ ${fmtNum(o.rows)}` : '')));
      }
    }
  }
  function drawOpts() {
    const c = conn();
    clear(opts);
    opts.append(h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'Content'), seg('content', [['all', 'Structure + data'], ['schema', 'Structure only'], ['data', 'Data only']], () => suggestOut(true))));
    const native = { postgres: tools.pg_dump, mysql: tools.mysqldump, mongo: tools.mongodump }[c.type];
    if (['postgres', 'mysql', 'mongo'].includes(c.type)) {
      opts.append(h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'Engine'), seg('engine', [['auto', 'Auto'], ['native', native ? native.file.split('/').pop() : 'Native tool'], ['builtin', 'Built-in']], () => suggestOut(true))));
    }
    clear(toolLine);
    if (c.type === 'sqlite' || c.type === 'db2' || st.engine === 'builtin' || !native) {
      toolLine.append(icon('zap'), h('span', {}, st.engine === 'native' && !native ? 'The native tool was not found — install it or choose Built-in.' : 'Built-in dumper: streams rows in batches, memory stays flat for any table size.'));
    } else toolLine.append(icon('check'), h('span', {}, `${native.version.split('\n')[0]}`), h('span', { class: 'muted mono' }, native.file));
    if (c.type === 'postgres') {
      if (st.content !== 'schema') opts.append(h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'Data as'), seg('dataFormat', [['insert', 'INSERT (portable)'], ['copy', 'COPY (fastest, psql)']])));
      if (native && st.engine !== 'builtin') opts.append(h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'Format'), seg('pgFormat', [['plain', 'Plain SQL'], ['custom', 'Custom archive (pg_restore)']], () => suggestOut(true))));
      opts.append(check('noOwner', 'Skip owners and privileges', '(restores cleanly into another server)'));
    }
    opts.append(check('dropIfExists', c.type === 'mongo' ? 'Drop collections before restoring' : 'Add DROP … IF EXISTS before each object'));
    if (!(c.type === 'postgres' && st.pgFormat === 'custom')) opts.append(check('gzip', 'Compress with gzip'));
  }

  async function run() {
    const c = conn();
    if (!st.out) { toast('Choose where to save the dump', 'error'); return; }
    let tables = [];
    let schemas = [];
    if (st.scope === 'tables') { tables = [...st.tables].map((k) => { const [schema, table] = k.split('\u0000'); return { schema, table }; }); if (!tables.length) { toast('Pick at least one table', 'error'); return; } }
    if (st.scope === 'schemas') { schemas = [...st.schemas]; if (!schemas.length) { toast('Pick at least one schema', 'error'); return; } }
    if (st.scope === 'database' && c.type === 'sqlite') schemas = schemaList;
    const out = st.out.replace(/^~\//, (app.state.home || '') + '/');
    runBtn.disabled = true;
    progress.style.display = '';
    const bar = h('i');
    const label = h('div', { class: 'dp-label' }, 'Starting…');
    const log = h('div', { class: 'dp-log mono' });
    const cancel = h('button', { class: 'btn sm', onclick: () => api.dump.cancel() }, 'Cancel');
    clear(progress).append(h('div', { class: 'dp-top' }, h('span', { class: 'bar big' }, bar), cancel), label, log);
    const off = api.on.dumpProgress((e) => {
      if (e.tablesTotal) bar.style.width = Math.round(((e.tablesDone || 0) + (e.rows && e.rowsTotal ? Math.min(1, e.rows / e.rowsTotal) : 0)) / e.tablesTotal * 100) + '%';
      if (e.table) label.textContent = `${e.table}${e.rows != null ? ` · ${fmtNum(e.rows)} rows` : ''}${e.bytes ? ` · ${fmtBytes(e.bytes)}` : ''}${e.tablesTotal ? ` · table ${Math.min((e.tablesDone || 0) + 1, e.tablesTotal)} of ${e.tablesTotal}` : ''}`;
      if (e.message) { log.append(h('div', {}, e.message)); while (log.childNodes.length > 400) log.firstChild.remove(); log.scrollTop = log.scrollHeight; }
    });
    try {
      const r = await api.dump.run({ connId: c.id, db: st.db, scope: st.scope === 'database' && c.type !== 'sqlite' ? 'database' : st.scope === 'database' ? 'schemas' : st.scope, schemas, tables, content: st.content, engine: st.engine, out, gzip: st.gzip, dropIfExists: st.dropIfExists, noOwner: st.noOwner, dataFormat: st.dataFormat, pgFormat: st.pgFormat });
      bar.style.width = '100%';
      bar.classList.add('done');
      label.textContent = `Saved ${r.out.split('/').pop()} · ${fmtBytes(r.bytes)} · ${(r.ms / 1000).toFixed(1)} s · ${r.engine === 'native' ? 'native tool' : 'built-in dumper'}`;
      cancel.replaceWith(h('button', { class: 'btn sm', onclick: () => api.shell.reveal(r.out) }, icon('folder'), 'Show in Finder'));
      toast('Dump finished', 'ok');
    } catch (e) {
      label.textContent = '';
      label.append(h('span', { class: 'err-text' }, icon('warning'), e.message));
      bar.classList.add('fail');
      cancel.remove();
    } finally { off(); runBtn.disabled = false; }
  }

  const m = modal({
    title: 'Dump', subtitle: 'Database, schemas or tables — structure, data or both', width: 760, cls: 'dump-modal',
    body: h('div', { class: 'dump' },
      h('div', { class: 'frow' }, h('label', { class: 'field' }, h('span', {}, 'Connection'), connSel), h('label', { class: 'field' }, h('span', {}, 'Database'), dbSel)),
      h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'What'), scopeEl),
      pick, opts, toolLine,
      h('label', { class: 'field' }, h('span', {}, 'Save to'), h('div', { class: 'with-btns' }, outIn, h('button', { class: 'btn', onclick: async () => { const p = await api.dump.pickOut(st.out.split('/').pop() || 'dump' + ext()); if (p) { st.out = p; st.outTouched = true; outIn.value = p.replace(app.state.home || '\u0000', '~'); } } }, 'Choose…'))),
      progress),
    foot: [h('span', { class: 'muted sm' }, conn() ? engineBadge(conn().type, 'xs') : null, ' Dumps never change the database.'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Close'), runBtn],
  });
  load();
  return m;
}
