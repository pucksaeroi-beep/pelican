'use strict';
const pg = require('pg');
const Cursor = require('pg-cursor');
const { cell, txMismatch } = require('./base.cjs');
const { statementKind, quoteIdent, qualified } = require('../lib/sqltext.cjs');

// Keep dates, times, int8 and numeric as the server's text: no time-zone shifts, no float rounding.
for (const oid of [1082, 1083, 1114, 1184, 1266, 20, 1700]) pg.types.setTypeParser(oid, (v) => v);

const SYSTEM = /^(pg_catalog|information_schema|pg_toast|pg_temp_\d+|pg_toast_temp_\d+)$/;

class PgDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.dialect = 'pg';
    this.hasDatabases = true;
    this.pools = new Map();
    this.sessions = new Map(); // editor tab id → { client, db }
    this.running = new Map(); // run id → { pid, db }
  }
  pool(db) {
    db = db || this.cfg.database || 'postgres';
    let p = this.pools.get(db);
    if (!p) {
      const c = this.cfg;
      p = new pg.Pool({
        host: c.host || '127.0.0.1', port: +c.port || 5432, user: c.user || undefined, password: c.password || undefined,
        database: db, max: 5, idleTimeoutMillis: 60000, connectionTimeoutMillis: 8000, application_name: 'Pelican',
        ssl: c.ssl && c.ssl !== 'disable' ? { rejectUnauthorized: c.ssl === 'verify' } : undefined,
      });
      p.on('error', () => {}); // idle client died; the next query reconnects
      this.pools.set(db, p);
    }
    return p;
  }
  async connect() {
    const r = await this.pool().query('select version() as v, current_database() as db');
    this.version = r.rows[0].v.replace(/ on .*/, '').replace(/,.*$/, '');
    return { version: this.version };
  }
  async close() {
    for (const s of this.sessions.values()) s.client.release(true);
    this.sessions.clear();
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => {})));
    this.pools.clear();
  }
  async q(db, sql, params) { return this.pool(db).query(sql, params); }

  // ---------- metadata ----------
  async databases() {
    if (!this.cfg.showAllDatabases) return [this.cfg.database || 'postgres'];
    const r = await this.q(null, 'select datname from pg_database where not datistemplate and datallowconn order by datname = current_database() desc, datname');
    return r.rows.map((x) => x.datname);
  }
  async schemas(db, { system } = {}) {
    const r = await this.q(db, `select nspname as name from pg_namespace order by nspname = 'public' desc, nspname`);
    return r.rows.map((x) => x.name).filter((n) => system || !SYSTEM.test(n));
  }
  async objects(db, schema) {
    const r = await this.q(db, `
      select c.relname as name, c.relkind as kind, greatest(c.reltuples, -1)::bigint as est,
             case when c.relkind in ('r','p','m') then pg_total_relation_size(c.oid) end as size,
             obj_description(c.oid, 'pg_class') as comment
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p','v','m','f') and not c.relispartition
      order by c.relname`, [schema]);
    return r.rows.map((x) => ({ name: x.name, kind: x.kind === 'v' || x.kind === 'm' ? 'view' : 'table', sub: { r: 'table', p: 'partitioned', v: 'view', m: 'materialized view', f: 'foreign table' }[x.kind], rows: x.est >= 0 ? +x.est : null, size: x.size != null ? +x.size : null, comment: x.comment }));
  }
  async columns(db, schema, table) {
    const r = await this.q(db, `
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
             pg_get_expr(d.adbin, d.adrelid) as "default", col_description(c.oid, a.attnum) as comment,
             coalesce((select true from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)), false) as pk,
             a.attidentity as ident, a.attgenerated as gen
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [schema, table]);
    return r.rows;
  }
  async indexes(db, schema, table) {
    const r = await this.q(db, `
      select i.relname as name, ix.indisunique as unique, ix.indisprimary as primary, pg_get_indexdef(ix.indexrelid) as def,
             (select string_agg(pg_get_indexdef(ix.indexrelid, k, true), ', ' order by k) from generate_series(1, ix.indnkeyatts) k) as columns
      from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class t on t.oid = ix.indrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = $1 and t.relname = $2 order by ix.indisprimary desc, i.relname`, [schema, table]);
    return r.rows;
  }
  async foreignKeys(db, schema, table) {
    const r = await this.q(db, `
      select con.conname as name, pg_get_constraintdef(con.oid) as def, fn.nspname as ref_schema, ft.relname as ref_table
      from pg_constraint con join pg_class t on t.oid = con.conrelid join pg_namespace n on n.oid = t.relnamespace
      join pg_class ft on ft.oid = con.confrelid join pg_namespace fn on fn.oid = ft.relnamespace
      where con.contype = 'f' and n.nspname = $1 and t.relname = $2 order by con.conname`, [schema, table]);
    return r.rows;
  }
  async ddl(db, schema, table, { foreignKeys = true } = {}) {
    const k = await this.q(db, `select c.relkind, pg_get_viewdef(c.oid, true) as viewdef from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`, [schema, table]);
    if (!k.rows.length) throw new Error(`${schema}.${table} not found`);
    const name = qualified(schema, table, 'pg');
    const { relkind, viewdef } = k.rows[0];
    if (relkind === 'v') return `CREATE OR REPLACE VIEW ${name} AS\n${viewdef.trim()}\n`;
    if (relkind === 'm') return `CREATE MATERIALIZED VIEW ${name} AS\n${viewdef.trim()}\n`;
    const cols = await this.columns(db, schema, table);
    const cons = await this.q(db, `
      select con.conname as name, pg_get_constraintdef(con.oid) as def, con.contype
      from pg_constraint con join pg_class t on t.oid = con.conrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = $1 and t.relname = $2 and con.contype in ('p','u','c','f','x') order by con.contype = 'p' desc, con.conname`, [schema, table]);
    const lines = cols.map((c) => {
      let s = `  ${quoteIdent(c.name, 'pg')} ${c.type}`;
      if (c.ident === 'a') s += ' GENERATED ALWAYS AS IDENTITY';
      else if (c.ident === 'd') s += ' GENERATED BY DEFAULT AS IDENTITY';
      else if (c.gen === 's') s += ` GENERATED ALWAYS AS (${c.default}) STORED`;
      else if (c.default != null) s += ` DEFAULT ${c.default}`;
      if (!c.nullable) s += ' NOT NULL';
      return s;
    });
    // foreign keys go after all tables in a dump; inline them here for the DDL tab only
    for (const c of cons.rows) if (foreignKeys || c.contype !== 'f') lines.push(`  CONSTRAINT ${quoteIdent(c.name, 'pg')} ${c.def}`);
    let out = `CREATE TABLE ${name} (\n${lines.join(',\n')}\n);\n`;
    for (const ix of await this.indexes(db, schema, table)) if (!ix.primary && !cons.rows.some((c) => c.name === ix.name)) out += ix.def + ';\n';
    const tc = await this.q(db, `select obj_description(($1)::regclass, 'pg_class') as c`, [name]);
    if (tc.rows[0]?.c) out += `COMMENT ON TABLE ${name} IS '${tc.rows[0].c.replace(/'/g, "''")}';\n`;
    for (const c of cols) if (c.comment) out += `COMMENT ON COLUMN ${name}.${quoteIdent(c.name, 'pg')} IS '${c.comment.replace(/'/g, "''")}';\n`;
    return out;
  }

  /** Pieces a built-in dump needs around the tables. */
  async fkDdl(db, schema, table) {
    const r = await this.q(db, `select con.conname as name, pg_get_constraintdef(con.oid) as def from pg_constraint con join pg_class t on t.oid = con.conrelid join pg_namespace n on n.oid = t.relnamespace where con.contype = 'f' and n.nspname = $1 and t.relname = $2 order by 1`, [schema, table]);
    return r.rows.map((c) => `ALTER TABLE ${qualified(schema, table, 'pg')} ADD CONSTRAINT ${quoteIdent(c.name, 'pg')} ${c.def};`);
  }
  async preamble(db, schema) {
    const out = [];
    const en = await this.q(db, `select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace where n.nspname = $1 group by t.typname order by 1`, [schema]);
    for (const e of en.rows) out.push(`CREATE TYPE ${qualified(schema, e.name, 'pg')} AS ENUM (${parseArr(e.labels).map((l) => `'${l.replace(/'/g, "''")}'`).join(', ')});`);
    const seq = await this.q(db, `select c.relname as name, s.seqstart as start, s.seqincrement as inc, s.seqmin as min, s.seqmax as max, s.seqcycle as cycle, format_type(s.seqtypid, null) as type,
      exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'i') as identity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_sequence s on s.seqrelid = c.oid where n.nspname = $1 and c.relkind = 'S' order by 1`, [schema]);
    for (const s of seq.rows) if (!s.identity) out.push(`CREATE SEQUENCE IF NOT EXISTS ${qualified(schema, s.name, 'pg')} AS ${s.type} INCREMENT ${s.inc} MINVALUE ${s.min} MAXVALUE ${s.max} START ${s.start}${s.cycle ? ' CYCLE' : ''};`);
    return out;
  }
  async sequenceValues(db, schema) {
    const seq = await this.q(db, `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind = 'S' order by 1`, [schema]);
    const out = [];
    for (const s of seq.rows) {
      const r = await this.q(db, `select last_value, is_called from ${qualified(schema, s.name, 'pg')}`).catch(() => null);
      if (r?.rows[0]) out.push(`SELECT pg_catalog.setval('${qualified(schema, s.name, 'pg').replace(/'/g, "''")}', ${r.rows[0].last_value}, ${r.rows[0].is_called});`);
    }
    return out;
  }

  // ---------- queries ----------
  async client(db, session) {
    if (!session) return { client: await this.pool(db).connect(), done: (c, err) => c.release(err) };
    let s = this.sessions.get(session);
    if (s && s.db !== (db || this.cfg.database)) { s.client.release(); this.sessions.delete(session); s = null; }
    if (!s) { s = { client: await this.pool(db).connect(), db: db || this.cfg.database }; s.client.on('error', () => { this.sessions.delete(session); }); this.sessions.set(session, s); }
    return { client: s.client, done: () => {} };
  }
  endSession(session) { const s = this.sessions.get(session); if (s) { s.client.release(true); this.sessions.delete(session); } }
  /** Run statements in one transaction. A statement with `expect` must touch exactly that many rows. */
  async tx(db, stmts) {
    const client = await this.pool(db).connect();
    let broken;
    try {
      await client.query('BEGIN');
      const out = [];
      for (const st of stmts) {
        const r = await client.query(st.sql, st.params || []);
        out.push(r.rowCount);
        if (st.expect != null && r.rowCount !== st.expect) throw new Error(txMismatch(st, r.rowCount));
      }
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK').catch((x) => { broken = x; }); throw e; } finally { client.release(broken); }
  }

  async query(db, sql, params = [], { maxRows = 1000, readOnly = false, session, runId, schema } = {}) {
    const { client, done } = await this.client(db, readOnly ? null : session);
    if (runId) this.running.set(runId, { pid: client.processID, db });
    let failed;
    const sess = !readOnly && session ? this.sessions.get(session) : null;
    const tempPath = schema && !sess;
    try {
      if (schema && (tempPath || sess.schema !== schema)) {
        await client.query(`SET search_path TO ${quoteIdent(schema, 'pg')}, public`);
        if (sess) sess.schema = schema;
      }
      if (readOnly) await client.query('BEGIN TRANSACTION READ ONLY');
      if (statementKind(sql, 'pg') === 'read') {
        const cur = client.query(new Cursor(sql, params, { rowMode: 'array' }));
        const rows = await cur.read(maxRows + 1);
        const fields = cur._result?.fields || [];
        await cur.close();
        const truncated = rows.length > maxRows;
        if (truncated) rows.length = maxRows;
        return this.shape(fields, rows, null, truncated, 'SELECT');
      }
      const r = await client.query({ text: sql, values: params, rowMode: 'array' });
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      const rows = last.rows || [];
      const truncated = rows.length > maxRows;
      return this.shape(last.fields || [], truncated ? rows.slice(0, maxRows) : rows, last.fields?.length ? null : last.rowCount, truncated, last.command);
    } catch (e) { failed = e; throw e; }
    finally {
      if (readOnly) await client.query('ROLLBACK').catch(() => {});
      if (tempPath) await client.query('RESET search_path').catch(() => {});
      if (runId) this.running.delete(runId);
      done(client, failed && !client._connected ? failed : undefined);
    }
  }
  shape(fields, rows, affected, truncated, command) {
    const typeName = (oid) => PG_TYPES[oid] || String(oid);
    return {
      columns: fields.map((f) => ({ name: f.name, type: typeName(f.dataTypeID), table: f.tableID || undefined })),
      rows: rows.map((r) => r.map(cell)), affected, truncated, command,
    };
  }
  async cancel(runId) {
    const r = this.running.get(runId);
    if (r) await this.q(r.db, 'select pg_cancel_backend($1)', [r.pid]).catch(() => {});
  }

  /** Stream raw rows for a dump: every value in PostgreSQL's own text form, so it round-trips exactly. */
  async *stream(db, sql, batch = 2000) {
    const client = await this.pool(db).connect();
    try {
      const cur = client.query(new Cursor(sql, [], { rowMode: 'array', types: { getTypeParser: () => (v) => v } }));
      for (;;) {
        const rows = await cur.read(batch);
        if (!rows.length) break;
        yield { rows, fields: cur._result?.fields || [] };
      }
      await cur.close();
    } finally { client.release(); }
  }

  async explain(db, sql, { analyze = false, schema } = {}) {
    const opts = analyze ? 'FORMAT JSON, ANALYZE, BUFFERS, VERBOSE' : 'FORMAT JSON, VERBOSE';
    const { client, done } = await this.client(db);
    try {
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema, 'pg')}, public`);
      const write = statementKind(sql, 'pg') === 'write';
      if (analyze && write) await client.query('BEGIN');
      const r = await client.query(`EXPLAIN (${opts}) ${sql}`);
      if (analyze && write) await client.query('ROLLBACK');
      const doc = r.rows[0]['QUERY PLAN'][0];
      const root = toNode(doc.Plan);
      if (doc['Planning Time'] != null) root.props['Planning Time'] = doc['Planning Time'] + ' ms';
      if (doc['Execution Time'] != null) root.props['Execution Time'] = doc['Execution Time'] + ' ms';
      return { kind: 'pg', plan: root, raw: doc, analyzed: analyze };
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { if (schema) await client.query('RESET search_path').catch(() => {}); done(client); }
  }

  /** Tables a statement touches, from the planner (views expand to their base tables). */
  async planTables(db, sql, { schema } = {}) {
    const client = await this.pool(db).connect();
    let r;
    try {
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema, 'pg')}, public`);
      r = await client.query(`EXPLAIN (FORMAT JSON, VERBOSE) ${sql}`);
    } finally { if (schema) await client.query('RESET search_path').catch(() => {}); client.release(); }
    const out = [];
    const walk = (p) => {
      if (p['Relation Name']) out.push({ schema: p.Schema, table: p['Relation Name'] });
      if (p['Function Name'] && p.Schema && p.Schema !== 'pg_catalog') out.push({ schema: p.Schema, table: p['Function Name'], fn: true });
      (p.Plans || []).forEach(walk);
    };
    walk(r.rows[0]['QUERY PLAN'][0].Plan);
    return out;
  }
}

function parseArr(a) { return Array.isArray(a) ? a : String(a).replace(/^\{|\}$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')); }

function toNode(p) {
  const label = [p['Node Type'], p['Join Type'] && p['Node Type'].includes('Join') ? `(${p['Join Type']})` : '', p.Strategy && p.Strategy !== 'Plain' ? p.Strategy : ''].filter(Boolean).join(' ');
  const on = p['Relation Name'] ? `${p.Schema ? p.Schema + '.' : ''}${p['Relation Name']}${p.Alias && p.Alias !== p['Relation Name'] ? ' ' + p.Alias : ''}` : p['CTE Name'] || p['Function Name'] || '';
  const detail = [on, p['Index Name'] ? `using ${p['Index Name']}` : '', p['Hash Cond'] || p['Index Cond'] || p['Merge Cond'] || p['Join Filter'] || p.Filter || ''].filter(Boolean).join(' · ');
  const skip = new Set(['Plans', 'Node Type', 'Output']);
  const props = {};
  for (const [k, v] of Object.entries(p)) if (!skip.has(k)) props[k] = Array.isArray(v) ? v.join(', ') : v;
  return {
    label, detail, cost: p['Total Cost'], startupCost: p['Startup Cost'], rows: p['Plan Rows'], width: p['Plan Width'],
    actualRows: p['Actual Rows'], time: p['Actual Total Time'] != null ? p['Actual Total Time'] * (p['Actual Loops'] || 1) : undefined,
    loops: p['Actual Loops'], props, children: (p.Plans || []).map(toNode),
  };
}

const PG_TYPES = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid', 114: 'json',
  142: 'xml', 700: 'float4', 701: 'float8', 790: 'money', 869: 'inet', 650: 'cidr', 829: 'macaddr', 1042: 'bpchar', 1043: 'varchar',
  1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1266: 'timetz', 1560: 'bit',
  1562: 'varbit', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 1000: 'bool[]', 1005: 'int2[]', 1007: 'int4[]', 1016: 'int8[]',
  1009: 'text[]', 1015: 'varchar[]', 1021: 'float4[]', 1022: 'float8[]', 2951: 'uuid[]', 3807: 'jsonb[]', 3614: 'tsvector',
  600: 'point', 1231: 'numeric[]', 1185: 'timestamptz[]', 1115: 'timestamp[]', 1182: 'date[]',
};

module.exports = { PgDriver };
