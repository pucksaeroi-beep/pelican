'use strict';
// Pelican's MCP server (Streamable HTTP, JSON responses) on 127.0.0.1.
//
// Every connection is closed to AI clients until you open it in the MCP window. Per connection you choose:
//   access  off | read | write          read-only runs inside a READ ONLY transaction (pg, MySQL) or a read-only
//                                       handle (SQLite), on top of a statement check; Db2 relies on the check
//   scope   all | custom                custom = only the schemas / tables you tick; the tables a statement touches
//                                       are read from the database's own planner (EXPLAIN), not guessed from text
//   confirm ask before every write      a native dialog shows the statement and waits for Allow / Deny
const http = require('http');
const crypto = require('crypto');
const { BSON } = require('mongodb');
const { readOnlyProblem, statementKind, splitStatements } = require('./lib/sqltext.cjs');

const { EJSON } = BSON;
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const scopeKey = (db, schema) => `${db || ''}|${schema}`;
const same = (a, b, ci) => (ci ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** Can this policy see db.schema.table? (table omitted = "anything in this schema"). */
function allowed(policy, db, schema, table, ci) {
  if (!policy || policy.access === 'off' || !policy.access) return false;
  if (policy.scope !== 'custom') return true;
  for (const [key, entry] of Object.entries(policy.allow || {})) {
    const [kdb, ks] = key.split('|');
    if (kdb && db && !same(kdb, db, ci)) continue;
    if (!same(ks, schema, ci)) continue;
    if (entry === '*' || table == null) return true;
    if (Array.isArray(entry) && entry.some((t) => same(t, table, ci))) return true;
  }
  return false;
}
function schemaVisible(policy, db, schema, ci) {
  if (policy.scope !== 'custom') return true;
  return Object.keys(policy.allow || {}).some((key) => { const [kdb, ks] = key.split('|'); return (!kdb || !db || same(kdb, db, ci)) && same(ks, schema, ci); });
}

class McpServer {
  /**
   * deps: { config(): { mcp, connections }, open(id) → {cfg, driver}, log(entry), activity(entry), confirm(info) → Promise<bool> }
   */
  constructor(deps) { this.deps = deps; this.server = null; }

  get settings() { return this.deps.config().mcp || {}; }
  policy(id) { return this.settings.policies?.[id] || { access: 'off' }; }
  enabledConnections() {
    return this.deps.config().connections.filter((c) => (this.policy(c.id).access || 'off') !== 'off');
  }

  start() {
    const { port = 7429 } = this.settings;
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res).catch((e) => { try { res.writeHead(500); res.end(String(e.message)); } catch { /* closed */ } }));
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => { this.server = srv; this.port = port; resolve(port); });
    });
  }
  stop() { return new Promise((r) => { if (!this.server) return r(); this.server.close(() => r()); this.server.closeAllConnections?.(); this.server = null; }); }
  get running() { return !!this.server; }

  async handle(req, res) {
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(body == null ? '' : JSON.stringify(body)); };
    // only this machine, and never a web page in a browser (DNS-rebinding / CSRF)
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(403, { error: 'forbidden host' });
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(403, { error: 'forbidden origin' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/mcp') return send(404, { error: 'not found — the endpoint is /mcp' });
    const token = this.settings.token;
    if (token && this.settings.requireToken !== false) {
      const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(got); const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(401, { error: 'missing or wrong token (Authorization: Bearer …)' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (req.method === 'GET') return send(405, null, { Allow: 'POST' });
    if (req.method === 'DELETE') return send(200, null);
    if (req.method !== 'POST') return send(405, null, { Allow: 'POST' });

    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2e6) return send(413, { error: 'too large' }); }
    let msg;
    try { msg = JSON.parse(body); } catch { return send(400, rpcError(null, -32700, 'Parse error')); }
    const batch = Array.isArray(msg);
    const replies = [];
    for (const m of batch ? msg : [msg]) {
      const r = await this.rpc(m);
      if (r) replies.push(r);
    }
    if (!replies.length) return send(202, null);
    return send(200, batch ? replies : replies[0]);
  }

  async rpc(m) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id != null ? rpcError(m.id, -32600, 'Invalid request') : null;
    const isNote = m.id === undefined || m.id === null;
    try {
      let result;
      switch (m.method) {
        case 'initialize': {
          const want = m.params?.protocolVersion;
          result = {
            protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'pelican', title: 'Pelican database client', version: require('../package.json').version },
            instructions: INSTRUCTIONS,
          };
          break;
        }
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: this.tools() }; break;
        case 'tools/call': result = await this.call(m.params?.name, m.params?.arguments || {}); break;
        case 'resources/list': result = { resources: [] }; break;
        case 'prompts/list': result = { prompts: [] }; break;
        default:
          if (m.method.startsWith('notifications/')) return null;
          return isNote ? null : rpcError(m.id, -32601, `Method not found: ${m.method}`);
      }
      return isNote ? null : { jsonrpc: '2.0', id: m.id, result };
    } catch (e) {
      return isNote ? null : rpcError(m.id, -32603, e.message);
    }
  }

  tools() {
    const conns = this.enabledConnections();
    const names = conns.map((c) => c.name);
    const anyWrite = conns.some((c) => this.policy(c.id).access === 'write');
    const sql = conns.some((c) => c.type !== 'mongo');
    const mongo = conns.some((c) => c.type === 'mongo');
    const conn = { type: 'string', description: `Connection name. Open connections: ${names.length ? names.join(', ') : '(none — the user has not shared any)'}` };
    const where = {
      database: { type: 'string', description: 'PostgreSQL: database name (default: the connection\'s database).' },
      schema: { type: 'string', description: 'Schema (PostgreSQL / Db2), database (MySQL) or database (MongoDB) to use for unqualified names.' },
    };
    const t = [
      { name: 'list_connections', title: 'List database connections', description: 'Database connections the user has shared with you, with their access level (read or write) and scope.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'list_tables', title: 'List tables', description: 'Schemas and tables (or MongoDB databases and collections) you may use on a connection, with estimated row counts.', inputSchema: { type: 'object', properties: { connection: conn, ...where }, required: ['connection'] }, annotations: { readOnlyHint: true } },
      { name: 'describe_table', title: 'Describe a table', description: 'Columns (type, nullability, default, primary key), indexes, foreign keys, partitioning (key and partitions with their bounds) and the CREATE statement of one table or collection.', inputSchema: { type: 'object', properties: { connection: conn, schema: { type: 'string' }, table: { type: 'string' }, database: where.database }, required: ['connection', 'schema', 'table'] }, annotations: { readOnlyHint: true } },
    ];
    if (sql) {
      t.push({ name: 'query', title: 'Run a read-only SQL query', description: 'Run one SELECT / WITH / SHOW / EXPLAIN statement and get rows back as JSON. Reads only; the connection\'s scope limits which tables you can touch.', inputSchema: { type: 'object', properties: { connection: conn, sql: { type: 'string' }, ...where, max_rows: { type: 'integer', minimum: 1, maximum: 5000, description: 'Default 200.' } }, required: ['connection', 'sql'] }, annotations: { readOnlyHint: true } });
      t.push({ name: 'explain', title: 'Explain a query', description: 'The execution plan of one SQL statement as a tree (node type, table, estimated cost and rows). analyze=true also runs it (reads only, unless the connection allows writes) and adds real timings.', inputSchema: { type: 'object', properties: { connection: conn, sql: { type: 'string' }, ...where, analyze: { type: 'boolean' } }, required: ['connection', 'sql'] }, annotations: { readOnlyHint: true } });
      if (anyWrite) t.push({ name: 'execute', title: 'Run a SQL statement that changes data', description: 'Run one INSERT / UPDATE / DELETE / DDL statement on a connection where the user allowed writes. The user may be asked to approve it first.', inputSchema: { type: 'object', properties: { connection: conn, sql: { type: 'string' }, ...where }, required: ['connection', 'sql'] }, annotations: { destructiveHint: true } });
    }
    if (mongo) {
      t.push({ name: 'mongo_find', title: 'Find MongoDB documents', description: 'find() on a collection. filter / projection / sort are MongoDB Extended JSON objects (use {"$oid": "…"} and {"$date": "…"}).', inputSchema: { type: 'object', properties: { connection: conn, database: { type: 'string' }, collection: { type: 'string' }, filter: { type: 'object' }, projection: { type: 'object' }, sort: { type: 'object' }, limit: { type: 'integer', minimum: 1, maximum: 5000 } }, required: ['connection', 'collection'] }, annotations: { readOnlyHint: true } });
      t.push({ name: 'mongo_aggregate', title: 'Aggregate MongoDB documents', description: 'aggregate() on a collection. $out and $merge need write access. $lookup / $unionWith collections must be in scope.', inputSchema: { type: 'object', properties: { connection: conn, database: { type: 'string' }, collection: { type: 'string' }, pipeline: { type: 'array', items: { type: 'object' } }, limit: { type: 'integer' } }, required: ['connection', 'collection', 'pipeline'] }, annotations: { readOnlyHint: true } });
      if (anyWrite) t.push({ name: 'mongo_write', title: 'Change MongoDB documents', description: 'insertOne / insertMany / updateOne / updateMany / deleteOne / deleteMany on a collection where writes are allowed.', inputSchema: { type: 'object', properties: { connection: conn, database: { type: 'string' }, collection: { type: 'string' }, operation: { type: 'string', enum: ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'] }, filter: { type: 'object' }, update: { type: 'object' }, document: { type: 'object' }, documents: { type: 'array', items: { type: 'object' } } }, required: ['connection', 'collection', 'operation'] }, annotations: { destructiveHint: true } });
    }
    return t;
  }

  conn(name) {
    const all = this.enabledConnections();
    const c = all.find((x) => x.name === name) || all.find((x) => x.id === name) || all.find((x) => x.name.toLowerCase() === String(name || '').toLowerCase());
    if (!c) throw new UserError(`No shared connection called "${name}". Shared: ${all.map((x) => x.name).join(', ') || 'none'}.`);
    return { c, policy: this.policy(c.id) };
  }

  async call(name, a) {
    const started = Date.now();
    const entry = { time: new Date().toISOString(), tool: name, connection: a.connection || '', sql: a.sql || (a.collection ? `${a.collection}${a.operation ? '.' + a.operation : ''}` : ''), ok: true };
    try {
      const out = await this.dispatch(name, a, entry);
      entry.ms = Date.now() - started;
      this.deps.activity(entry);
      return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] };
    } catch (e) {
      entry.ok = false; entry.error = e.message; entry.ms = Date.now() - started;
      entry.denied = e instanceof UserError && e.denied;
      this.deps.activity(entry);
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
  }

  async dispatch(name, a, entry) {
    if (name === 'list_connections') {
      return this.enabledConnections().map((c) => {
        const p = this.policy(c.id);
        return { name: c.name, type: c.type, database: c.database || c.file || undefined, access: p.access, scope: p.scope === 'custom' ? Object.entries(p.allow || {}).map(([k, v]) => `${k.replace(/^\|/, '').replace('|', '.')}${v === '*' ? '.*' : ` (${v.join(', ')})`}`) : 'everything', max_rows: p.maxRows || 200 };
      });
    }
    const { c, policy } = this.conn(a.connection);
    entry.connection = c.name;
    const { driver } = await this.deps.open(c.id);
    const ci = c.type === 'mysql';
    const db = c.type === 'postgres' ? (a.database || c.database || 'postgres') : null;
    const maxRows = Math.min(+a.max_rows || +a.limit || policy.maxRows || 200, policy.maxRows || 5000);

    if (name === 'list_tables') {
      const schemas = a.schema ? [a.schema] : await driver.schemas(db);
      const out = {};
      for (const s of schemas) {
        if (!schemaVisible(policy, db, s, ci)) continue;
        const objs = (await driver.objects(db, s)).filter((o) => allowed(policy, db, s, o.name, ci));
        if (objs.length) out[s] = objs.map((o) => ({ name: o.name, type: o.sub || o.kind, rows: o.rows ?? undefined, partition_key: o.partitionKey, partitions: o.partitions, comment: o.comment || undefined }));
      }
      return { connection: c.name, type: c.type, database: db || undefined, schemas: out };
    }
    if (name === 'describe_table') {
      // a partition is in scope when the partitioned table it belongs to is
      const parts = driver.partitions ? await driver.partitions(db, a.schema, a.table).catch(() => null) : null;
      const owner = parts?.root || { schema: a.schema, table: a.table };
      if (!allowed(policy, db, owner.schema, owner.table, ci)) throw denied(`${a.schema}.${a.table} is outside this connection's scope.`);
      const [columns, indexes, fks, ddl] = await Promise.all([driver.columns(db, a.schema, a.table), driver.indexes(db, a.schema, a.table), driver.foreignKeys(db, a.schema, a.table), driver.ddl(db, a.schema, a.table).catch(() => '')]);
      const out = { table: `${a.schema}.${a.table}`, columns: columns.map((x) => ({ name: x.name, type: x.type, nullable: x.nullable, default: x.default ?? undefined, primary_key: x.pk || undefined, comment: x.comment || undefined })), indexes: indexes.map((i) => ({ name: i.name, columns: i.columns, unique: i.unique })), foreign_keys: fks.filter((f) => allowed(policy, db, f.ref_schema, f.ref_table, ci)).map((f) => ({ name: f.name, definition: f.def })) };
      if (parts?.key) {
        out.partitioning = {
          partition_by: parts.key,
          partitions: parts.partitions.slice(0, 500).map((x) => ({ name: `${x.schema}.${x.name}`, bound: x.bound, rows: x.rows ?? undefined, ...(x.level > 1 ? { parent: x.parent } : {}), ...(x.key ? { partition_by: x.key } : {}) })),
          note: `Filter on the partition key (${parts.key.replace(/^\w+\s*/, '')}) so PostgreSQL scans only the partitions that can match. Querying ${a.schema}.${a.table} reads all of its partitions.`,
        };
        if (parts.partitions.length > 500) out.partitioning.more = parts.partitions.length - 500;
      }
      if (parts?.partitionOf) out.partition_of = { table: `${parts.partitionOf.schema}.${parts.partitionOf.table}`, bound: parts.partitionOf.bound, top_level: `${parts.root.schema}.${parts.root.table}` };
      out.ddl = ddl;
      return out;
    }
    if (c.type === 'mongo') return this.mongo(name, a, c, policy, driver, maxRows);

    if (name === 'query' || name === 'explain' || name === 'execute') {
      const sql = String(a.sql || '').trim();
      if (!sql) throw new UserError('sql is empty.');
      if (splitStatements(sql, driver.dialect).length !== 1) throw new UserError('Send exactly one statement per call.');
      const kind = statementKind(sql, driver.dialect);
      const write = name === 'execute' || (name === 'explain' && a.analyze && kind === 'write');
      if (write && policy.access !== 'write') throw denied(`"${c.name}" is read-only for AI clients.`);
      if (name === 'query' || (name === 'explain' && a.analyze && !write)) { const p = readOnlyProblem(sql, driver.dialect); if (p) throw denied(p + (policy.access === 'write' ? ' Use the execute tool for changes.' : '')); }
      if (name === 'execute' && kind === 'read') throw new UserError('This is a read statement; use the query tool.');
      // scope: which tables does the statement touch, according to the database itself?
      if (policy.scope === 'custom') {
        let tables;
        try { tables = await driver.planTables(db, sql, { schema: a.schema }); } catch (e) { throw new UserError(e.message); }
        const bad = tables.filter((t) => !allowed(policy, db, t.schema, t.table, ci));
        if (bad.length) throw denied(`Not allowed on this connection: ${[...new Set(bad.map((t) => `${t.schema}.${t.table}`))].join(', ')}. Use list_tables to see what is shared.`);
        if (!tables.length && /\bfrom\b/i.test(sql)) throw denied('Could not tell which tables this statement reads, so it was blocked.');
      }
      if (name === 'explain') {
        const r = await driver.explain(db, sql, { analyze: !!a.analyze, schema: a.schema });
        return { plan: compactPlan(r.plan), analyzed: !!r.analyzed };
      }
      if (name === 'execute') {
        if (policy.confirmWrites !== false) {
          const ok = await this.deps.confirm({ connection: c.name, sql });
          if (!ok) throw denied('The user declined this change.');
        }
        const r = await driver.query(db, sql, [], { maxRows, schema: a.schema });
        this.deps.log({ connId: c.id, sql, rows: r.affected ?? r.rows.length, type: 'mcp', ok: true });
        return { command: r.command, affected_rows: r.affected ?? undefined, rows: r.rows.length ? r.rows : undefined, columns: r.columns.length ? r.columns.map((x) => x.name) : undefined };
      }
      const r = await driver.query(db, sql, [], { maxRows, readOnly: true, schema: a.schema });
      entry.rows = r.rows.length;
      this.deps.log({ connId: c.id, sql, rows: r.rows.length, type: 'mcp', ok: true });
      return { columns: r.columns.map((x) => ({ name: x.name, type: x.type })), rows: r.rows, row_count: r.rows.length, truncated: r.truncated || undefined };
    }
    throw new UserError(`Unknown tool: ${name}`);
  }

  async mongo(name, a, c, policy, driver, maxRows) {
    const dbName = a.database || a.schema || c.database || driver.defaultDb();
    const check = (coll) => { if (!allowed(policy, null, dbName, coll, false)) throw denied(`${dbName}.${coll} is outside this connection's scope.`); };
    const ej = (v) => (v == null ? v : EJSON.deserialize(v, { relaxed: true }));
    const coll = () => driver.client.db(dbName).collection(a.collection);
    if (name === 'mongo_find') {
      check(a.collection);
      let cur = coll().find(ej(a.filter) || {}, a.projection ? { projection: ej(a.projection) } : {});
      if (a.sort) cur = cur.sort(ej(a.sort));
      const docs = await cur.limit(maxRows + 1).toArray();
      const truncated = docs.length > maxRows;
      return { documents: docs.slice(0, maxRows).map((d) => EJSON.serialize(d, { relaxed: true })), count: Math.min(docs.length, maxRows), truncated: truncated || undefined };
    }
    if (name === 'mongo_aggregate') {
      check(a.collection);
      const pipeline = ej(a.pipeline) || [];
      if (!Array.isArray(pipeline)) throw new UserError('pipeline must be an array.');
      let writes = false;
      for (const st of pipeline) {
        const k = Object.keys(st)[0];
        if (k === '$out' || k === '$merge') { writes = true; check(typeof st[k] === 'string' ? st[k] : st[k].coll || st[k].into); }
        const from = st.$lookup?.from || st.$graphLookup?.from || (typeof st.$unionWith === 'string' ? st.$unionWith : st.$unionWith?.coll);
        if (from) check(from);
      }
      if (writes && policy.access !== 'write') throw denied('$out / $merge need write access.');
      if (writes && policy.confirmWrites !== false && !(await this.deps.confirm({ connection: c.name, sql: `db.${a.collection}.aggregate(${JSON.stringify(a.pipeline)})` }))) throw denied('The user declined this change.');
      const docs = await coll().aggregate(writes ? pipeline : [...pipeline, { $limit: maxRows + 1 }]).toArray();
      return { documents: docs.slice(0, maxRows).map((d) => EJSON.serialize(d, { relaxed: true })), truncated: docs.length > maxRows || undefined };
    }
    if (name === 'mongo_write') {
      check(a.collection);
      if (policy.access !== 'write') throw denied(`"${c.name}" is read-only for AI clients.`);
      const ops = { insertOne: () => coll().insertOne(ej(a.document)), insertMany: () => coll().insertMany(ej(a.documents) || []), updateOne: () => coll().updateOne(ej(a.filter) || {}, ej(a.update)), updateMany: () => coll().updateMany(ej(a.filter) || {}, ej(a.update)), deleteOne: () => coll().deleteOne(ej(a.filter) || {}), deleteMany: () => coll().deleteMany(ej(a.filter) || {}) };
      if (!ops[a.operation]) throw new UserError('Unknown operation.');
      if (policy.confirmWrites !== false && !(await this.deps.confirm({ connection: c.name, sql: `db.${a.collection}.${a.operation}(${JSON.stringify(a.filter || a.document || a.documents || {})}${a.update ? ', ' + JSON.stringify(a.update) : ''})` }))) throw denied('The user declined this change.');
      const r = await ops[a.operation]();
      return EJSON.serialize(r, { relaxed: true });
    }
    throw new UserError(`"${c.name}" is MongoDB: use mongo_find, mongo_aggregate${policy.access === 'write' ? ' or mongo_write' : ''}.`);
  }
}

class UserError extends Error {}
function denied(msg) { const e = new UserError(msg); e.denied = true; return e; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function compactPlan(n) {
  const o = { node: n.label };
  if (n.detail) o.detail = n.detail;
  for (const k of ['cost', 'rows', 'actualRows', 'time', 'loops']) if (n[k] != null) o[k] = n[k];
  if (n.children?.length) o.children = n.children.map(compactPlan);
  return o;
}

const INSTRUCTIONS = `Pelican is the user's desktop database client. It shares only the connections the user opened for AI access, each read-only or read-write, optionally limited to some schemas or tables.
Start with list_connections, then list_tables and describe_table before writing SQL. Use query for reads (one statement per call; results are capped by max_rows) and explain to look at a plan. PostgreSQL partitioned tables: list_tables shows the parent with partition_key; describe_table lists its partitions and bounds. Query the parent and filter on the partition key so only the matching partitions are scanned; scope set on the parent covers its partitions. Writes (execute, mongo_write) exist only where the user allowed them and may need the user's approval. If a call is denied, tell the user what you needed rather than retrying around it.`;

module.exports = { McpServer, allowed, scopeKey };
