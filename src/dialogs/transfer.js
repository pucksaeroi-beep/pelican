// Transfer: copy tables, a schema or a whole database from one connection into another — typically from a
// shared server into a database on this Mac. Structure, rows and indexes; SQL ↔ SQL across engines, Mongo → Mongo.
import { h, icon, clear, fmtNum, debounce } from '../ui/h.js';
import { modal, toast, confirmBox } from '../ui/overlay.js';
import { app, api } from '../app.js';
import { ENGINES } from '../ui/icons.js';

const LS = 'pelican.transfer.target';
const isLocal = (c) => c.type === 'sqlite' || (!c.uri && ['', 'localhost', '127.0.0.1', '::1'].includes(String(c.host || '').trim().toLowerCase()));
const word = (type) => (type === 'mysql' || type === 'mongo' ? 'database' : 'schema');
const sqlFamily = (type) => type !== 'mongo';

export function transferDialog(pre = {}) {
  const conns = app.state.connections;
  if (conns.length < 2) { toast('Add the database to copy into first — e.g. a PostgreSQL or SQLite connection on this Mac.', 'info', 5000); }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS) || '{}'); } catch { /* none */ }
  const st = {
    from: pre.connId || conns[0]?.id, srcDb: pre.db ?? null, to: null, dstDb: null, dstSchema: '',
    picked: new Set(), ifExists: saved.ifExists || 'fail', structure: true, data: true, indexes: true, adaptCase: true,
  };
  let schemaList = [];
  let objects = new Map(); // schema → objects
  let dstSchemas = [];
  const src = () => app.conn(st.from);
  const dst = () => app.conn(st.to);
  const k = (s, t) => `${s}\u0000${t}`;

  function pickTarget() {
    const s = src();
    const ok = conns.filter((c) => c.id !== s?.id && sqlFamily(c.type) === sqlFamily(s?.type));
    const last = ok.find((c) => c.id === saved.to);
    st.to = (last || ok.find((c) => isLocal(c) && c.type === s?.type) || ok.find(isLocal) || ok[0])?.id || null;
  }
  pickTarget();

  // ---------- source ----------
  const fromSel = h('select', { class: 'input' });
  const fromDb = h('select', { class: 'input' });
  const fromDbField = h('label', { class: 'field' }, h('span', {}, 'Database'), fromDb);
  const search = h('input', { class: 'input sm', placeholder: 'Filter tables', oninput: debounce(() => drawPick(), 100) });
  const pick = h('div', { class: 'dump-pick xfer-pick' });
  const pickInfo = h('div', { class: 'muted sm xfer-count' });

  // ---------- target ----------
  const toSel = h('select', { class: 'input' });
  const toDb = h('select', { class: 'input' });
  const toDbField = h('label', { class: 'field' }, h('span', {}, 'Database'), toDb);
  const toSchema = h('input', { class: 'input', spellcheck: false, list: 'xfer-dst-schemas' });
  const toSchemaList = h('datalist', { id: 'xfer-dst-schemas' });
  const toSchemaLabel = h('span', {}, 'Into schema');
  const toSchemaField = h('label', { class: 'field' }, toSchemaLabel, toSchema, toSchemaList);
  const dstInfo = h('div', { class: 'muted sm xfer-dst-info' });
  const opts = h('div', { class: 'dump-opts' });
  const note = h('div', { class: 'tool-line' });
  const progress = h('div', { class: 'xfer-progress', style: { display: 'none' } });
  const runBtn = h('button', { class: 'btn primary', onclick: () => run() }, icon('transfer'), 'Start transfer');

  function drawConnSelects() {
    clear(fromSel).append(conns.map((c) => h('option', { value: c.id, selected: c.id === st.from }, `${c.name} — ${ENGINES[c.type]?.name || c.type}`)));
    const s = src();
    const fit = conns.filter((c) => sqlFamily(c.type) === sqlFamily(s?.type));
    const local = fit.filter(isLocal); const remote = fit.filter((c) => !isLocal(c));
    clear(toSel).append(
      local.length ? h('optgroup', { label: 'On this Mac' }, local.map((c) => h('option', { value: c.id, selected: c.id === st.to }, `${c.name} — ${ENGINES[c.type]?.name || c.type}`))) : null,
      remote.length ? h('optgroup', { label: 'Other servers' }, remote.map((c) => h('option', { value: c.id, selected: c.id === st.to }, `${c.name} — ${ENGINES[c.type]?.name || c.type}`))) : null);
    if (!fit.length) toSel.append(h('option', { value: '' }, 'No matching connection'));
  }
  fromSel.addEventListener('change', () => { st.from = fromSel.value; st.srcDb = null; st.picked.clear(); pre = {}; pickTarget(); drawConnSelects(); loadSource(); loadTarget(); });
  fromDb.addEventListener('change', () => { st.srcDb = fromDb.value; st.picked.clear(); loadSchemas(); });
  toSel.addEventListener('change', () => { st.to = toSel.value; st.dstDb = null; st.dstSchema = ''; toSchema.value = ''; loadTarget(); });
  toDb.addEventListener('change', () => { st.dstDb = toDb.value; loadTargetSchemas(); });
  toSchema.addEventListener('input', () => { st.dstSchema = toSchema.value.trim(); drawDstInfo(); });

  async function loadSource() {
    const c = src();
    if (!c) return;
    clear(pick).append(h('div', { class: 'muted pad' }, h('span', { class: 'spin' }), ' Loading…'));
    try {
      await app.connect(c.id);
      if (c.type === 'postgres') {
        const dbs = await api.meta.databases(c.id);
        st.srcDb = st.srcDb || c.database || dbs[0];
        clear(fromDb).append(dbs.map((d) => h('option', { value: d, selected: d === st.srcDb }, d)));
        fromDbField.style.display = dbs.length > 1 ? '' : 'none';
      } else fromDbField.style.display = 'none';
      await loadSchemas();
    } catch (e) { clear(pick).append(h('div', { class: 'err-text pad' }, icon('warning'), e.message)); }
  }
  async function loadSchemas() {
    const c = src();
    schemaList = await api.meta.schemas(c.id, st.srcDb);
    objects = new Map();
    await Promise.all(schemaList.map(async (s) => objects.set(s, (await api.meta.objects(c.id, st.srcDb, s).catch(() => [])).filter((o) => o.kind !== 'view'))));
    if (!st.picked.size) {
      if (pre.tables?.length) for (const t of pre.tables) st.picked.add(k(pre.schema, t));
      else if (pre.schema) for (const o of objects.get(pre.schema) || []) st.picked.add(k(pre.schema, o.name));
      else if (c.type === 'mysql' || c.type === 'mongo') { const s0 = c.database && objects.has(c.database) ? c.database : null; if (s0) for (const o of objects.get(s0)) st.picked.add(k(s0, o.name)); }
      else for (const [s, l] of objects) for (const o of l) st.picked.add(k(s, o.name));
    }
    drawPick(); drawDstInfo();
  }
  function drawPick() {
    clear(pick);
    const c = src();
    const q = search.value.toLowerCase();
    pick.append(h('div', { class: 'pick-tools' }, search,
      h('button', { class: 'link', onclick: () => { for (const [s, l] of objects) for (const o of l) if (!q || o.name.toLowerCase().includes(q)) st.picked.add(k(s, o.name)); drawPick(); drawDstInfo(); } }, 'Select all'),
      h('button', { class: 'link', onclick: () => { st.picked.clear(); drawPick(); drawDstInfo(); } }, 'None')));
    let shown = 0;
    for (const s of schemaList) {
      const list = (objects.get(s) || []).filter((o) => !q || o.name.toLowerCase().includes(q));
      if (!list.length) continue;
      if (c.type !== 'sqlite' || schemaList.length > 1) {
        const all = list.every((o) => st.picked.has(k(s, o.name)));
        const some = list.some((o) => st.picked.has(k(s, o.name)));
        const sbox = h('input', { type: 'checkbox', checked: all });
        sbox.indeterminate = some && !all;
        sbox.addEventListener('change', () => { for (const o of list) { if (sbox.checked) st.picked.add(k(s, o.name)); else st.picked.delete(k(s, o.name)); } drawPick(); drawDstInfo(); });
        pick.append(h('label', { class: 'pick-row pick-schema' }, sbox, icon(word(c.type) === 'database' ? 'database' : 'schema'), h('b', {}, s), h('span', { class: 'muted' }, `${list.length}`)));
      }
      for (const o of list) {
        const box = h('input', { type: 'checkbox', checked: st.picked.has(k(s, o.name)) });
        box.addEventListener('change', () => { if (box.checked) st.picked.add(k(s, o.name)); else st.picked.delete(k(s, o.name)); drawPick(); drawDstInfo(); });
        pick.append(h('label', { class: 'pick-row pick-table' }, box, icon(c.type === 'mongo' ? 'collection' : 'table'), h('span', {}, o.name), h('span', { class: 'muted' }, o.rows != null ? `≈ ${fmtNum(o.rows)}` : '')));
        shown++;
      }
    }
    if (!shown) pick.append(h('div', { class: 'muted pad' }, q ? 'No tables match' : 'No tables here'));
    const n = st.picked.size;
    const rows = [...st.picked].reduce((a, key) => { const [s, t] = key.split('\u0000'); const o = (objects.get(s) || []).find((x) => x.name === t); return a + (o?.rows || 0); }, 0);
    pickInfo.textContent = `${n} ${c.type === 'mongo' ? 'collection' : 'table'}${n === 1 ? '' : 's'} picked${rows ? ` · ≈ ${fmtNum(rows)} rows` : ''}`;
  }

  async function loadTarget() {
    const c = dst();
    drawOpts();
    if (!c) { drawDstInfo(); return; }
    try { localStorage.setItem(LS, JSON.stringify({ ...saved, to: c.id })); } catch { /* private */ }
    toSchemaLabel.textContent = c.type === 'sqlite' ? 'Into' : `Into ${word(c.type)}`;
    toSchemaField.style.display = c.type === 'sqlite' ? 'none' : '';
    try {
      await app.connect(c.id);
      if (c.type === 'postgres') {
        const dbs = await api.meta.databases(c.id);
        st.dstDb = st.dstDb || c.database || dbs[0];
        clear(toDb).append(dbs.map((d) => h('option', { value: d, selected: d === st.dstDb }, d)));
        toDbField.style.display = '';
      } else toDbField.style.display = 'none';
      await loadTargetSchemas();
    } catch (e) { clear(dstInfo).append(h('span', { class: 'err-text' }, icon('warning'), e.message)); }
  }
  async function loadTargetSchemas() {
    const c = dst();
    dstSchemas = c.type === 'sqlite' ? ['main'] : await api.meta.schemas(c.id, st.dstDb).catch(() => []);
    clear(toSchemaList).append(dstSchemas.map((s) => h('option', { value: s })));
    drawDstInfo();
  }
  function srcSchemas() { return [...new Set([...st.picked].map((x) => x.split('\u0000')[0]))]; }
  function drawDstInfo() {
    const s = src(); const d = dst();
    clear(dstInfo);
    if (!s || !d) return;
    const ss = srcSchemas();
    toSchema.placeholder = ss.length === 1 ? `${ss[0]}  (same name as the source)` : 'Same names as the source';
    if (d.type === 'sqlite') { dstInfo.append(icon('database'), `Tables go into ${d.file?.split('/').pop() || 'the file'}`); return; }
    const target = st.dstSchema || (ss.length === 1 ? ss[0] : null);
    if (target) {
      const exists = dstSchemas.some((x) => x === target || (d.type === 'mysql' && x.toLowerCase() === target.toLowerCase()));
      dstInfo.append(icon(exists ? 'check' : 'plus'), exists ? `${target} exists — tables are added to it` : `${target} will be created`);
    } else dstInfo.append(icon('info'), `Each ${word(s.type)} keeps its name: ${ss.join(', ')}`);
    if (s.id === d.id && (st.srcDb || '') === (st.dstDb || '') && (!st.dstSchema || ss.includes(st.dstSchema))) dstInfo.append(h('div', { class: 'err-text' }, icon('warning'), 'That is the source itself — type another name.'));
  }

  const seg = (key, items) => h('div', { class: 'seg' }, items.map(([v, l]) => h('button', { class: st[key] === v ? 'on' : '', onclick: () => { st[key] = v; try { localStorage.setItem(LS, JSON.stringify({ ...saved, to: st.to, ifExists: st.ifExists })); } catch { /* private */ } drawOpts(); } }, l)));
  const check = (key, label, hint) => { const el = h('input', { type: 'checkbox', checked: !!st[key] }); el.addEventListener('change', () => { st[key] = el.checked; }); return h('label', { class: 'check' }, el, h('span', {}, label), hint ? h('small', { class: 'muted' }, hint) : null); };
  function drawOpts() {
    const s = src(); const d = dst();
    clear(opts);
    opts.append(h('div', { class: 'opt-row' }, h('span', { class: 'opt-l' }, 'If it exists'), seg('ifExists', [['fail', 'Stop'], ['drop', 'Drop and recreate'], ['truncate', 'Empty it first'], ['append', 'Add rows']])));
    opts.append(h('div', { class: 'xfer-checks' }, check('structure', s?.type === 'mongo' ? 'Create collections' : 'Create tables'), check('data', s?.type === 'mongo' ? 'Copy documents' : 'Copy rows'), check('indexes', 'Copy indexes'),
      s && d && (s.type === 'db2') !== (d.type === 'db2') ? check('adaptCase', 'Change name case for Db2', d.type === 'db2' ? '(orders → ORDERS)' : '(ORDERS → orders)') : null));
    clear(note);
    if (!s || !d) return;
    if (s.type === d.type) note.append(icon('check'), h('span', {}, s.type === 'mongo' ? 'Documents are copied as they are, BSON types included.' : `Same engine: column types and defaults are copied as written. Foreign keys, triggers and views are not copied.`));
    else note.append(icon('info'), h('span', {}, `${ENGINES[s.type].name} → ${ENGINES[d.type].name}: column types are mapped (e.g. ${mapExample(s.type, d.type)}). Foreign keys, triggers and views are not copied.`));
  }
  function mapExample(a, b) {
    const ex = { postgres: { mysql: 'jsonb → json, bytea → longblob, timestamptz → datetime in UTC', sqlite: 'jsonb → TEXT, boolean → BOOLEAN (0/1)', db2: 'text → CLOB, jsonb → CLOB, boolean → BOOLEAN' },
      mysql: { postgres: 'tinyint(1) → boolean, datetime → timestamp, longblob → bytea', sqlite: 'varchar → VARCHAR, json → TEXT', db2: 'longtext → CLOB, datetime → TIMESTAMP' },
      sqlite: { postgres: 'INTEGER → bigint, TEXT → text, BLOB → bytea', mysql: 'TEXT → longtext, BLOB → longblob', db2: 'TEXT → CLOB, BLOB → BLOB' },
      db2: { postgres: 'CLOB → text, DECFLOAT → numeric, TIMESTAMP → timestamp', mysql: 'CLOB → longtext, TIMESTAMP → datetime(6)', sqlite: 'CLOB → TEXT, DECIMAL → NUMERIC' } };
    return ex[a]?.[b] || 'to the closest type';
  }

  async function run() {
    const s = src(); const d = dst();
    if (!s || !d) { toast('Pick where to copy to', 'error'); return; }
    const items = [...st.picked].map((x) => { const [schema, table] = x.split('\u0000'); return { schema, table }; });
    if (!items.length) { toast('Pick at least one table', 'error'); return; }
    const target = d.type === 'sqlite' ? d.file?.split('/').pop() : `${d.name}${st.dstDb && d.type === 'postgres' ? ' / ' + st.dstDb : ''}${st.dstSchema ? ' / ' + st.dstSchema : ''}`;
    if (st.ifExists === 'drop' || st.ifExists === 'truncate') {
      const ok = await confirmBox({ title: st.ifExists === 'drop' ? 'Drop tables on the target?' : 'Empty tables on the target?', danger: true, ok: st.ifExists === 'drop' ? 'Drop and copy' : 'Empty and copy',
        message: `Tables on “${target}” with the same names as the ${items.length} picked will be ${st.ifExists === 'drop' ? 'dropped and created again' : 'emptied'} before copying. “${s.name}” is not changed.` });
      if (!ok) return;
    }
    runBtn.disabled = true;
    progress.style.display = '';
    const rowsEl = new Map();
    const head = h('div', { class: 'xp-head' }, h('span', { class: 'spin' }), h('b', {}, `Copying ${items.length} ${s.type === 'mongo' ? 'collection' : 'table'}${items.length === 1 ? '' : 's'}`), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => api.transfer.cancel() }, 'Cancel'));
    const list = h('div', { class: 'xp-list' });
    for (const it of items) {
      const el = h('div', { class: 'xp-row' }, h('span', { class: 'xp-ic muted' }, icon('table')), h('span', { class: 'xp-name' }, items.some((x) => x.schema !== it.schema) ? `${it.schema}.${it.table}` : it.table), h('span', { class: 'xp-to muted' }), h('span', { class: 'xp-rows muted' }, 'waiting'));
      rowsEl.set(`${it.schema}\u0000${it.table}`, el);
      list.append(el);
    }
    clear(progress).append(head, list);
    const off = api.on.transferProgress((e) => {
      const el = rowsEl.get(e.key);
      if (!el) return;
      const [ic, , to, rows] = el.children;
      el.className = 'xp-row ' + e.status;
      clear(ic).append(e.status === 'running' ? h('span', { class: 'spin' }) : icon(e.status === 'done' ? 'check' : e.status === 'error' ? 'warning' : 'x'));
      to.textContent = e.to ? `→ ${e.to}` : '';
      rows.textContent = e.status === 'error' ? '' : `${fmtNum(e.rows || 0)} rows`;
      el.querySelector('.xp-msg')?.remove();
      if (e.error || e.notes?.length) el.append(h('div', { class: 'xp-msg' + (e.error ? ' err-text' : ' muted') }, e.error || e.notes.join(' · ')));
      if (e.status === 'running') el.scrollIntoView({ block: 'nearest' });
    });
    try {
      const r = await api.transfer.run({ from: s.id, to: d.id, srcDb: st.srcDb, dstDb: st.dstDb, dstSchema: d.type === 'sqlite' ? '' : st.dstSchema, items, ifExists: st.ifExists, structure: st.structure, data: st.data, indexes: st.indexes, adaptCase: st.adaptCase });
      clear(head).append(icon(r.errors ? 'warning' : 'check'), h('b', {}, r.cancelled ? 'Cancelled' : r.errors ? `${r.tables} copied, ${r.errors} failed` : `Copied ${r.tables} ${s.type === 'mongo' ? 'collection' : 'table'}${r.tables === 1 ? '' : 's'}`),
        h('span', { class: 'muted' }, `${fmtNum(r.rows)} rows · ${(r.ms / 1000).toFixed(1)} s`), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => { m.close(); app.emit('reveal-connection', d.id); } }, icon('database'), `Show in ${d.name}`));
      head.className = 'xp-head ' + (r.errors ? 'warn' : 'ok');
      if (!r.errors && !r.cancelled) toast(`Copied ${fmtNum(r.rows)} rows into ${d.name}`, 'ok');
      app.emit('meta-stale', d.id);
      loadTargetSchemas();
    } catch (e) {
      clear(head).append(h('span', { class: 'err-text' }, icon('warning'), e.message));
    } finally { off(); runBtn.disabled = false; }
  }

  const m = modal({
    title: 'Transfer', subtitle: 'Copy tables, a schema or a whole database into another database — e.g. one on this Mac', width: 900, cls: 'dump-modal xfer-modal',
    body: h('div', { class: 'xfer' },
      h('div', { class: 'xfer-cols' },
        h('section', { class: 'xfer-side' }, h('div', { class: 'xfer-h' }, 'From'),
          h('div', { class: 'frow' }, h('label', { class: 'field' }, h('span', {}, 'Connection'), fromSel), fromDbField),
          pick, pickInfo),
        h('div', { class: 'xfer-arrow' }, icon('chevronRight')),
        h('section', { class: 'xfer-side' }, h('div', { class: 'xfer-h' }, 'To'),
          h('label', { class: 'field' }, h('span', {}, 'Connection'), toSel), toDbField, toSchemaField, dstInfo, opts,
          h('button', { class: 'link xfer-new', onclick: () => { m.close(); app.emit('cmd', 'new-connection'); } }, icon('plus'), 'New connection on this Mac…'))),
      note, progress),
    foot: [h('span', { class: 'muted sm' }, 'The source is only read.'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Close'), runBtn],
  });
  drawConnSelects();
  drawOpts();
  loadSource();
  loadTarget();
  return m;
}

