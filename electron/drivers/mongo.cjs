'use strict';
// MongoDB. The editor takes mongosh-style JavaScript (db.users.find({...}).sort({...}).limit(10)), evaluated in a
// sandbox whose `db` only records what was asked; Pelican then runs those calls with the Node driver.
const vm = require('vm');
const { MongoClient, ObjectId, Decimal128, Long, Int32, Double, UUID, BSON } = require('mongodb');
const { cell } = require('./base.cjs');

const { EJSON } = BSON;
const READ_OPS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'listCollections', 'indexes', 'stats']);
const WRITE_STAGES = new Set(['$out', '$merge']);

class MongoDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.dialect = 'mongo';
    this.hasDatabases = false; // shown as: connection → database → collections
  }
  uri() {
    const c = this.cfg;
    if (c.uri) return c.uri;
    const auth = c.user ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password || '')}@` : '';
    const q = c.user ? `?authSource=${encodeURIComponent(c.authSource || 'admin')}` : '';
    const host = c.tunnel ? `${c.tunnel.host}:${c.tunnel.port}` : `${c.host || '127.0.0.1'}:${+c.port || 27017}`;
    return `mongodb://${auth}${host}/${q}`;
  }
  async connect() {
    const px = this.cfg.mongoProxy; // SOCKS5 for connection strings (the driver dials every replica-set member itself)
    const proxy = px ? { proxyHost: px.host, proxyPort: px.port, ...(px.user ? { proxyUsername: px.user, proxyPassword: px.pass } : {}) } : {};
    this.client = new MongoClient(this.uri(), { serverSelectionTimeoutMS: 8000, appName: 'Pelican', directConnection: !this.cfg.uri, ...proxy });
    await this.client.connect();
    const info = await this.client.db('admin').command({ buildInfo: 1 });
    this.version = 'MongoDB ' + info.version;
    return { version: this.version };
  }
  async close() { await this.client?.close().catch(() => {}); this.client = null; }
  defaultDb() { return this.cfg.database || (this.cfg.uri && new URL(this.cfg.uri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1)) || 'test'; }

  async databases() { return [null]; }
  async schemas(db, { system } = {}) {
    try {
      const r = await this.client.db('admin').admin().listDatabases({ nameOnly: true });
      const names = r.databases.map((d) => d.name).filter((n) => system || !['admin', 'local', 'config'].includes(n)).sort();
      const def = this.cfg.database;
      return def ? [def, ...names.filter((n) => n !== def)] : names;
    } catch { return [this.defaultDb()]; }
  }
  async objects(db, schema) {
    const list = await this.client.db(schema).listCollections({}, { nameOnly: false }).toArray();
    const out = [];
    for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (c.name.startsWith('system.')) continue;
      let rows = null;
      if (c.type !== 'view') rows = await this.client.db(schema).collection(c.name).estimatedDocumentCount().catch(() => null);
      out.push({ name: c.name, kind: c.type === 'view' ? 'view' : 'table', sub: c.type === 'view' ? 'view' : 'collection', rows, size: null });
    }
    return out;
  }
  async columns(db, schema, coll) {
    const docs = await this.client.db(schema).collection(coll).find({}).limit(200).toArray();
    const types = new Map([['_id', new Set()]]);
    for (const d of docs) for (const [k, v] of Object.entries(d)) { if (!types.has(k)) types.set(k, new Set()); types.get(k).add(typeOf(v)); }
    return [...types].map(([name, t]) => ({ name, type: [...t].join(' | ') || 'objectId', nullable: name !== '_id', pk: name === '_id', default: null, comment: null }));
  }
  async indexes(db, schema, coll) {
    const list = await this.client.db(schema).collection(coll).indexes();
    return list.map((ix) => ({ name: ix.name, unique: !!ix.unique || ix.name === '_id_', primary: ix.name === '_id_', columns: Object.entries(ix.key).map(([k, v]) => `${k}: ${v}`).join(', '), def: JSON.stringify(ix.key) }));
  }
  async foreignKeys() { return []; }
  async ddl(db, schema, coll) {
    const [info] = await this.client.db(schema).listCollections({ name: coll }).toArray();
    const idx = await this.client.db(schema).collection(coll).indexes();
    let s = `db.createCollection(${JSON.stringify(coll)}${info?.options && Object.keys(info.options).length ? ', ' + EJSON.stringify(info.options) : ''});\n`;
    for (const ix of idx) if (ix.name !== '_id_') {
      const { key, v, ns, ...opts } = ix;
      s += `db.getCollection(${JSON.stringify(coll)}).createIndex(${JSON.stringify(key)}, ${JSON.stringify(opts)});\n`;
    }
    return s;
  }

  // ---------- the mongosh-like sandbox ----------
  parse(text, schema) {
    const calls = [];
    const mk = (coll) => {
      const c = {};
      const add = (op, args, chain) => { const spec = { op, coll, args, mods: {} }; calls.push(spec); return chain ? cursor(spec) : spec; };
      for (const op of ['find', 'aggregate']) c[op] = (...a) => add(op, a, true);
      for (const op of ['findOne', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'indexes', 'stats', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'createIndex', 'dropIndex', 'drop', 'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'renameCollection']) c[op] = (...a) => add(op, a, false);
      c.count = (...a) => add('countDocuments', a, false);
      c.getIndexes = () => add('indexes', [], false);
      c.insert = (d) => add(Array.isArray(d) ? 'insertMany' : 'insertOne', [d], false);
      c.remove = (f) => add('deleteMany', [f], false);
      return c;
    };
    const cursor = (spec) => {
      const cur = { __spec: spec };
      for (const m of ['sort', 'skip', 'limit', 'project', 'projection', 'hint', 'collation', 'maxTimeMS']) cur[m] = (v) => { spec.mods[m === 'projection' ? 'project' : m] = v; return cur; };
      cur.toArray = () => cur;
      cur.pretty = () => cur;
      cur.count = () => { spec.op = spec.op === 'find' ? 'countDocuments' : spec.op; spec.args = [spec.args[0] || {}]; return spec; };
      cur.explain = () => { spec.explain = true; return cur; };
      return cur;
    };
    const target = {
      getCollection: (n) => mk(String(n)),
      getCollectionNames: () => { const s = { op: 'listCollections', coll: null, args: [], mods: {} }; calls.push(s); return s; },
      getName: () => schema,
    };
    const db = new Proxy(target, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? mk(k) : undefined) });
    const sandbox = vm.createContext({
      db, ObjectId: (s) => new ObjectId(s), ISODate: (s) => (s ? new Date(s) : new Date()), Date, NumberLong: (n) => Long.fromString(String(n)),
      NumberInt: (n) => new Int32(n), NumberDecimal: (n) => Decimal128.fromString(String(n)), Double: (n) => new Double(n), UUID: (s) => new UUID(s),
      Math, JSON, RegExp, Number, String, Boolean, Array, Object,
    });
    const value = vm.runInContext(text, sandbox, { timeout: 1000, displayErrors: false });
    return { calls, value: value && value.__spec ? value.__spec : value };
  }

  /** Collections a script touches (for MCP scope checks), and whether it writes. */
  inspect(text, schema) {
    const { calls } = this.parse(text, schema);
    const tables = [];
    let writes = false;
    for (const c of calls) {
      if (c.coll) tables.push({ schema, table: c.coll });
      if (!READ_OPS.has(c.op)) writes = true;
      if (c.op === 'aggregate') for (const st of c.args[0] || []) {
        const k = Object.keys(st)[0];
        if (WRITE_STAGES.has(k)) writes = true;
        const from = st.$lookup?.from || st.$graphLookup?.from || (typeof st.$unionWith === 'string' ? st.$unionWith : st.$unionWith?.coll);
        if (from) tables.push({ schema, table: from });
        if (k === '$out' || k === '$merge') tables.push({ schema, table: typeof st[k] === 'string' ? st[k] : st[k].coll || st[k].into });
      }
    }
    return { tables, writes, calls };
  }

  async run(schema, spec, maxRows) {
    const db = this.client.db(schema);
    if (spec.op === 'listCollections') return (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => ({ name: c.name }));
    const coll = db.collection(spec.coll);
    const a = spec.args;
    if (spec.op === 'find' || spec.op === 'aggregate') {
      let cur = spec.op === 'find' ? coll.find(a[0] || {}, a[1] ? { projection: a[1] } : {}) : coll.aggregate(a[0] || [], a[1] || {});
      const m = spec.mods;
      if (m.sort) cur = cur.sort(m.sort);
      if (m.skip) cur = cur.skip(m.skip);
      if (m.project) cur = cur.project(m.project);
      if (m.hint) cur = cur.hint(m.hint);
      if (m.maxTimeMS) cur = cur.maxTimeMS(m.maxTimeMS);
      if (spec.explain) return cur.explain('executionStats');
      const lim = Math.min(m.limit || Infinity, maxRows + 1);
      if (spec.op === 'find') cur = cur.limit(lim);
      const docs = [];
      for await (const d of cur) { docs.push(d); if (docs.length >= lim) break; }
      await cur.close();
      return docs;
    }
    if (typeof coll[spec.op] !== 'function') throw new Error(`Unsupported method: ${spec.op}`);
    return coll[spec.op](...a);
  }

  async query(db, text, params, { maxRows = 1000, readOnly = false, schema } = {}) {
    schema = schema || this.defaultDb();
    const { calls, value } = this.parse(text, schema);
    if (readOnly) {
      const { writes } = this.inspect(text, schema);
      if (writes) throw new Error('This connection is read-only: only find, aggregate (without $out/$merge), count and distinct are allowed.');
    }
    let result = value;
    for (const c of calls) {
      if (c === value) continue;
      if (!READ_OPS.has(c.op)) await this.run(schema, c, maxRows); // writes earlier in the script still happen
    }
    if (value && value.op) result = await this.run(schema, value, maxRows);
    return toGrid(result, maxRows);
  }

  // Data tab of a collection
  async find(schema, coll, { filter = {}, sort, limit = 200, offset = 0 } = {}) {
    let cur = this.client.db(schema).collection(coll).find(filter);
    if (sort && Object.keys(sort).length) cur = cur.sort(sort);
    const docs = await cur.skip(offset).limit(limit + 1).toArray();
    return toGrid(docs, limit);
  }
  async count(schema, coll, filter = {}) { return this.client.db(schema).collection(coll).countDocuments(filter); }
  async distinctCounts(schema, coll, field, filter = {}) {
    const rows = await this.client.db(schema).collection(coll).aggregate([{ $match: filter }, { $group: { _id: '$' + field, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 300 }]).toArray();
    return rows.map((r) => ({ v: tag(r._id), n: r.n }));
  }
  parseFilter(text) {
    if (!text || !String(text).trim()) return {};
    const sandbox = vm.createContext({ ObjectId: (s) => new ObjectId(s), ISODate: (s) => new Date(s), Date, RegExp, NumberLong: (n) => Long.fromString(String(n)), NumberDecimal: (n) => Decimal128.fromString(String(n)) });
    const v = vm.runInContext(`(${text})`, sandbox, { timeout: 500 });
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The filter must be an object, e.g. { status: "paid", total: { $gt: 100 } }');
    return v;
  }
  /** Column filters from the grid → a $match document. */
  filterDoc(filters = []) {
    const and = [];
    const val = (v) => (v && typeof v === 'object' ? EJSON.deserialize(v) : v);
    for (const f of filters) {
      const vs = (f.values || []).map(val);
      if (f.op === 'in') and.push({ [f.col]: { $in: vs } });
      else if (f.op === 'nin') and.push({ [f.col]: { $nin: vs } });
      else if (f.op === 'eq') and.push({ [f.col]: num(vs[0]) });
      else if (f.op === 'ne') and.push({ [f.col]: { $ne: num(vs[0]) } });
      else if (['gt', 'gte', 'lt', 'lte'].includes(f.op)) and.push({ [f.col]: { ['$' + f.op]: num(vs[0]) } });
      else if (f.op === 'contains') and.push({ [f.col]: { $regex: escapeRe(vs[0]), $options: 'i' } });
      else if (f.op === 'starts') and.push({ [f.col]: { $regex: '^' + escapeRe(vs[0]), $options: 'i' } });
      else if (f.op === 'null') and.push({ [f.col]: null });
      else if (f.op === 'notnull') and.push({ [f.col]: { $ne: null } });
    }
    return and;
  }
  async explain(db, text, { schema } = {}) {
    schema = schema || this.defaultDb();
    const { value } = this.parse(text, schema);
    if (!value || !['find', 'aggregate'].includes(value.op)) throw new Error('Explain works on find() and aggregate().');
    value.explain = true;
    const r = await this.run(schema, value, 1000);
    const qp = r.queryPlanner || r.stages?.[0]?.$cursor?.queryPlanner || {};
    const es = r.executionStats || r.stages?.[0]?.$cursor?.executionStats;
    const plan = mongoNode(es?.executionStages || qp.winningPlan?.queryPlan || qp.winningPlan || {}, !!es);
    plan.props = { ...plan.props, namespace: qp.namespace, ...(es ? { 'Execution time': es.executionTimeMillis + ' ms', 'Docs examined': es.totalDocsExamined, 'Keys examined': es.totalKeysExamined, Returned: es.nReturned } : {}) };
    return { kind: 'mongo', plan, raw: r, analyzed: !!es };
  }
  async planTables(db, text, { schema } = {}) { return this.inspect(text, schema || this.defaultDb()).tables; }

  /** Grid edits. key = [{ col: '_id', v: EJSON }]; set / values = [{ col, v: text | null, orig: EJSON }]. */
  editOps(changes) {
    const doc = (list) => Object.fromEntries((list || []).map((c) => [c.col, mongoValue(c.v, c.orig)]));
    return changes.map((ch) => {
      const id = ch.key ? EJSON.deserialize({ v: ch.key.find((k) => k.col === '_id')?.v }).v : undefined;
      if (ch.op !== 'insert' && id === undefined) throw new Error('A document to change has no _id.');
      if (ch.op === 'update') return { op: 'updateOne', filter: { _id: id }, update: { $set: doc(ch.set) } };
      if (ch.op === 'delete') return { op: 'deleteOne', filter: { _id: id } };
      return { op: 'insertOne', doc: doc(ch.values) };
    });
  }
  async applyEdits(schema, coll, changes) {
    const c = this.client.db(schema).collection(coll);
    const ops = this.editOps(changes);
    let done = 0;
    for (const o of ops) {
      const r = o.op === 'insertOne' ? await c.insertOne(o.doc) : o.op === 'deleteOne' ? await c.deleteOne(o.filter) : await c.updateOne(o.filter, o.update);
      const n = o.op === 'insertOne' ? 1 : o.op === 'deleteOne' ? r.deletedCount : r.matchedCount;
      if (n !== 1) throw new Error(`Change ${done + 1} found no document with that _id${done ? ` (the ${done} change${done > 1 ? 's' : ''} before it were saved)` : ''}. Refresh and try again.`);
      done++;
    }
    return ops.map(() => 1);
  }
  editsText(coll, changes) {
    const name = `db.getCollection(${JSON.stringify(coll)})`;
    return this.editOps(changes).map((o) => {
      const j = (v) => EJSON.stringify(v, { relaxed: true });
      if (o.op === 'insertOne') return `${name}.insertOne(${j(o.doc)});`;
      if (o.op === 'deleteOne') return `${name}.deleteOne(${j(o.filter)});`;
      return `${name}.updateOne(${j(o.filter)}, ${j(o.update)});`;
    }).join('\n');
  }
  async *stream(db, coll, batch = 1000, schema) {
    const cur = this.client.db(schema).collection(coll).find({}, { batchSize: batch });
    let buf = [];
    for await (const d of cur) { buf.push(d); if (buf.length >= batch) { yield { docs: buf }; buf = []; } }
    if (buf.length) yield { docs: buf };
  }
}

/** A value typed in the grid, given the field's old value (relaxed EJSON) so numbers stay numbers, dates stay dates. */
function mongoValue(text, orig) {
  if (text === null) return null;
  const s = String(text);
  const ejson = () => EJSON.parse(s, { relaxed: true });
  if (typeof orig === 'number') { if (s.trim() === '' || isNaN(s)) throw new Error(`“${s}” is not a number.`); return Number(s); }
  if (typeof orig === 'boolean') { if (!/^(true|false)$/i.test(s.trim())) throw new Error(`“${s}” is not true or false.`); return /^true$/i.test(s.trim()); }
  if (orig && typeof orig === 'object') {
    if ('$oid' in orig) return new ObjectId(s.trim());
    if ('$date' in orig) { const d = new Date(s.trim()); if (isNaN(d)) throw new Error(`“${s}” is not a date.`); return d; }
    if ('$numberDecimal' in orig) return Decimal128.fromString(s.trim());
    if ('$numberLong' in orig) return Long.fromString(s.trim());
    try { return ejson(); } catch { throw new Error(`The value of an object or array field must be JSON: ${s.slice(0, 60)}`); }
  }
  if (orig === undefined || orig === null) {
    if (/^\s*[[{]/.test(s) || /^(true|false|-?\d+(\.\d+)?)$/.test(s.trim())) { try { return ejson(); } catch { /* plain text */ } }
  }
  return s;
}
function num(v) { return typeof v === 'string' && v.trim() !== '' && !isNaN(v) ? Number(v) : v; }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function typeOf(v) {
  if (v === null) return 'null';
  if (v instanceof Date) return 'date';
  if (Array.isArray(v)) return 'array';
  if (v && v._bsontype) return v._bsontype === 'ObjectId' ? 'objectId' : v._bsontype.toLowerCase();
  return typeof v === 'object' ? 'object' : typeof v;
}
/** distinct values keep their BSON type so a filter on them matches (ObjectId, Date). */
function tag(v) {
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v && v._bsontype === 'ObjectId') return { $oid: v.toHexString() };
  if (v && typeof v === 'object') return cell(v);
  return v === undefined ? null : v;
}

function toGrid(result, maxRows) {
  if (result === undefined) return { columns: [], rows: [], affected: null, truncated: false, command: 'OK' };
  if (Array.isArray(result) && (result.length === 0 || (result[0] && typeof result[0] === 'object' && !Array.isArray(result[0]) && !result[0]._bsontype))) {
    const truncated = result.length > maxRows;
    const docs = truncated ? result.slice(0, maxRows) : result;
    const keys = new Map();
    for (const d of docs) for (const k of Object.keys(d)) if (!keys.has(k)) keys.set(k, typeOf(d[k]));
    const cols = [...keys.keys()].sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
    return {
      columns: cols.map((k) => ({ name: k, type: keys.get(k) })),
      rows: docs.map((d) => cols.map((k) => (k in d ? cell(d[k]) : undefined))),
      docs: docs.map((d) => EJSON.serialize(d, { relaxed: true })), affected: null, truncated, command: 'FIND',
    };
  }
  if (result && typeof result === 'object' && !Array.isArray(result) && ('acknowledged' in result || 'insertedId' in result || 'modifiedCount' in result || 'deletedCount' in result)) {
    const affected = result.insertedCount ?? (result.insertedId ? 1 : undefined) ?? result.modifiedCount ?? result.deletedCount ?? null;
    return { columns: [{ name: 'result', type: 'object' }], rows: [[cell(result)]], affected, truncated: false, command: 'WRITE' };
  }
  return { columns: [{ name: 'value', type: typeOf(result) }], rows: [[cell(result)]], affected: null, truncated: false, command: 'VALUE' };
}

function mongoNode(st, analyzed) {
  const kids = st.inputStage ? [st.inputStage] : st.inputStages || (st.queryPlan ? [st.queryPlan] : []);
  const detail = [st.indexName ? `index ${st.indexName}` : '', st.filter ? 'filter ' + JSON.stringify(st.filter) : '', st.keyPattern && !st.indexName ? JSON.stringify(st.keyPattern) : ''].filter(Boolean).join(' · ');
  const props = {};
  for (const [k, v] of Object.entries(st)) if (!['inputStage', 'inputStages', 'queryPlan'].includes(k)) props[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  return {
    label: st.stage || 'PLAN', detail, rows: undefined, actualRows: analyzed ? st.nReturned : undefined,
    time: analyzed ? st.executionTimeMillisEstimate : undefined, props, warn: st.stage === 'COLLSCAN', children: kids.map((k) => mongoNode(k, analyzed)),
  };
}

module.exports = { MongoDriver };
