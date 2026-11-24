'use strict';
const mysql = require('mysql2/promise');
const mysqlCb = require('mysql2');
const { cell, treeFromIndented } = require('./base.cjs');
const { statementKind, quoteIdent, qualified } = require('../lib/sqltext.cjs');

const SYSTEM = /^(mysql|sys|performance_schema|information_schema)$/i;

class MysqlDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.dialect = 'mysql';
    this.hasDatabases = false; // MySQL "databases" are shown as schemas
    this.sessions = new Map();
    this.running = new Map();
  }
  get pool() {
    if (!this._pool) {
      const c = this.cfg;
      this._pool = mysql.createPool({
        host: c.host || '127.0.0.1', port: +c.port || 3306, user: c.user || 'root', password: c.password || undefined,
        database: c.database || undefined, connectionLimit: 5, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
        multipleStatements: false, connectTimeout: 8000, charset: 'utf8mb4', decimalNumbers: false,
        ssl: c.ssl && c.ssl !== 'disable' ? { rejectUnauthorized: c.ssl === 'verify' } : undefined,
      });
      this._pool.pool.on('error', () => {});
    }
    return this._pool;
  }
  async connect() {
    const [rows] = await this.pool.query('select version() as v');
    this.version = 'MySQL ' + rows[0].v;
    if (/mariadb/i.test(rows[0].v)) this.version = 'MariaDB ' + rows[0].v.replace(/-MariaDB.*/i, '');
    return { version: this.version };
  }
  async close() {
    for (const s of this.sessions.values()) s.conn.destroy();
    this.sessions.clear();
    if (this._pool) await this._pool.end().catch(() => {});
    this._pool = null;
  }
  async q(sql, params) { const [rows] = await this.pool.query(sql, params); return rows; }

  async databases() { return [null]; }
  async schemas(db, { system } = {}) {
    const rows = await this.q('select schema_name as name from information_schema.schemata order by schema_name');
    const names = rows.map((r) => r.name || r.NAME || r.SCHEMA_NAME).filter((n) => system || !SYSTEM.test(n));
    const def = this.cfg.database;
    return def && names.includes(def) ? [def, ...names.filter((n) => n !== def)] : names;
  }
  async objects(db, schema) {
    const rows = await this.q(`select table_name as name, table_type as type, table_rows as est, data_length + index_length as size, table_comment as comment
      from information_schema.tables where table_schema = ? order by table_name`, [schema]);
    return rows.map((r) => ({ name: r.name, kind: /VIEW/.test(r.type) ? 'view' : 'table', sub: /VIEW/.test(r.type) ? 'view' : 'table', rows: r.est != null ? +r.est : null, size: r.size != null ? +r.size : null, comment: r.comment || null }));
  }
  async columns(db, schema, table) {
    const rows = await this.q(`select column_name as name, column_type as type, is_nullable = 'YES' as nullable, column_default as \`default\`,
      column_comment as comment, column_key = 'PRI' as pk, extra from information_schema.columns
      where table_schema = ? and table_name = ? order by ordinal_position`, [schema, table]);
    return rows.map((r) => ({ ...r, nullable: !!r.nullable, pk: !!r.pk, comment: r.comment || null }));
  }
  async indexes(db, schema, table) {
    const rows = await this.q(`select index_name as name, non_unique = 0 as \`unique\`, index_name = 'PRIMARY' as \`primary\`,
      group_concat(column_name order by seq_in_index separator ', ') as columns, index_type as type
      from information_schema.statistics where table_schema = ? and table_name = ? group by index_name, non_unique, index_type order by index_name = 'PRIMARY' desc, index_name`, [schema, table]);
    return rows.map((r) => ({ ...r, unique: !!r.unique, primary: !!r.primary, def: `${r.type} (${r.columns})` }));
  }
  async foreignKeys(db, schema, table) {
    return this.q(`select constraint_name as name, referenced_table_schema as ref_schema, referenced_table_name as ref_table,
      concat('(', group_concat(column_name order by ordinal_position), ') → ', referenced_table_name, '(', group_concat(referenced_column_name order by ordinal_position), ')') as def
      from information_schema.key_column_usage where table_schema = ? and table_name = ? and referenced_table_name is not null group by constraint_name, referenced_table_schema, referenced_table_name`, [schema, table]);
  }
  async ddl(db, schema, table) {
    const rows = await this.q(`show create table ${qualified(schema, table, 'mysql')}`);
    const r = rows[0];
    return (r['Create Table'] || r['Create View']) + ';\n';
  }

  async conn(session) {
    if (!session) { const c = await this.pool.getConnection(); return { c, done: () => c.release() }; }
    let s = this.sessions.get(session);
    if (!s) { s = { conn: await this.pool.getConnection() }; this.sessions.set(session, s); }
    return { c: s.conn, done: () => {} };
  }
  endSession(session) { const s = this.sessions.get(session); if (s) { s.conn.release(); this.sessions.delete(session); } }

  async query(db, sql, params = [], { maxRows = 1000, readOnly = false, session, runId, schema } = {}) {
    const { c, done } = await this.conn(readOnly ? null : session);
    if (runId) this.running.set(runId, c.threadId);
    let dropped = false;
    try {
      if (schema) await c.query(`use ${quoteIdent(schema, 'mysql')}`);
      if (readOnly) await c.query('START TRANSACTION READ ONLY');
      if (statementKind(sql, 'mysql') === 'read') {
        // stream so a huge SELECT stops after maxRows instead of loading everything
        const res = await streamRows(c.connection, sql, params, maxRows);
        if (res.truncated) { // stop the server sending the rest: drop this connection
          c.destroy(); dropped = true;
          if (session) this.sessions.delete(session);
        }
        return { columns: res.fields.map(colOf), rows: res.rows.map((r) => r.map(cell)), affected: null, truncated: res.truncated, command: 'SELECT' };
      }
      const [r, fields] = await c.query({ sql, values: params, rowsAsArray: true });
      if (Array.isArray(r)) {
        const truncated = r.length > maxRows;
        return { columns: (fields || []).map(colOf), rows: r.slice(0, maxRows).map((x) => x.map(cell)), affected: null, truncated, command: 'SELECT' };
      }
      return { columns: [], rows: [], affected: r.affectedRows, truncated: false, command: sql.trim().split(/\s+/)[0].toUpperCase(), info: r.info || undefined };
    } finally {
      if (runId) this.running.delete(runId);
      if (!dropped) {
        if (readOnly) await c.query('ROLLBACK').catch(() => {});
        done();
      }
    }
  }
  async cancel(runId) {
    const tid = this.running.get(runId);
    if (tid) await this.q(`KILL QUERY ${tid | 0}`).catch(() => {});
  }
  async *stream(db, sql, batch = 2000) {
    const c = await this.pool.getConnection();
    try {
      const q = c.connection.query({ sql, rowsAsArray: true, typeCast: rawCast });
      let fields = [];
      let buf = [];
      const it = q.stream({ highWaterMark: batch });
      q.on('fields', (f) => { fields = f; });
      for await (const row of it) {
        buf.push(row);
        if (buf.length >= batch) { yield { rows: buf, fields }; buf = []; }
      }
      if (buf.length) yield { rows: buf, fields };
    } finally { c.release(); }
  }

  async explain(db, sql, { analyze = false, schema } = {}) {
    const { c, done } = await this.conn();
    try {
      if (schema) await c.query(`use ${quoteIdent(schema, 'mysql')}`);
      let text;
      try {
        const [rows] = await c.query(analyze ? `EXPLAIN ANALYZE ${sql}` : `EXPLAIN FORMAT=TREE ${sql}`);
        text = Object.values(rows[0])[0];
      } catch (e) {
        if (!/FORMAT=TREE|syntax/i.test(e.message)) throw e;
        const [rows] = await c.query(`EXPLAIN ${sql}`); // MariaDB / old MySQL: the classic table
        return { kind: 'table', table: rows };
      }
      const plan = treeFromIndented(String(text).split('\n'), parseMysqlLine);
      return { kind: 'mysql', plan, text, analyzed: analyze };
    } finally { done(); }
  }
  async planTables(db, sql, { schema } = {}) {
    const { c, done } = await this.conn();
    try {
      if (schema) await c.query(`use ${quoteIdent(schema, 'mysql')}`);
      await c.query(`EXPLAIN ${sql}`);
      const [w] = await c.query('SHOW WARNINGS');
      const note = (w.find((x) => x.Code === 1003) || {}).Message || '';
      const out = [];
      const re = /`((?:[^`]|``)+)`\.`((?:[^`]|``)+)`(?!\.)/g;
      let m;
      while ((m = re.exec(note))) out.push({ schema: m[1].replace(/``/g, '`'), table: m[2].replace(/``/g, '`') });
      // `db`.`table`.`column` matches as db.table above too; drop alias.column pairs that aren't real schemas
      const schemas = new Set((await this.schemas(null, { system: true })).map((s) => s.toLowerCase()));
      return out.filter((t) => schemas.has(t.schema.toLowerCase()));
    } finally { done(); }
  }
}

function streamRows(conn, sql, values, max) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let fields = [];
    let truncated = false;
    const q = conn.query({ sql, values, rowsAsArray: true });
    q.on('error', reject)
      .on('fields', (f) => { fields = f || []; })
      .on('result', (row) => {
        if (rows.length < max) rows.push(row);
        else if (!truncated) { truncated = true; resolve({ rows, fields, truncated }); }
      })
      .on('end', () => resolve({ rows, fields, truncated }));
  });
}
// keep dump values close to the wire: Buffers for binary, strings for the rest
function rawCast(field, next) {
  if (['BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'GEOMETRY', 'BIT'].includes(field.type) && field.charsetNr === 63) return field.buffer();
  if (field.type === 'JSON') return field.string();
  return next();
}
const FRIENDLY = { LONG: 'int', LONGLONG: 'bigint', SHORT: 'smallint', TINY: 'tinyint', INT24: 'mediumint', NEWDECIMAL: 'decimal', DECIMAL: 'decimal', VAR_STRING: 'varchar', VARCHAR: 'varchar', STRING: 'char', DOUBLE: 'double', FLOAT: 'float', BLOB: 'text', TINY_BLOB: 'text', MEDIUM_BLOB: 'text', LONG_BLOB: 'text', DATETIME: 'datetime', TIMESTAMP: 'timestamp', DATE: 'date', TIME: 'time', YEAR: 'year', JSON: 'json', BIT: 'bit', ENUM: 'enum', SET: 'set', GEOMETRY: 'geometry', NULL: 'null' };
const colOf = (f) => {
  const t = MYSQL_TYPES[f.columnType] || String(f.columnType);
  let type = FRIENDLY[t] || t.toLowerCase();
  if (type === 'text' && f.characterSet === 63) type = 'blob';
  return { name: f.name, type, table: f.orgTable || undefined };
};
const MYSQL_TYPES = Object.fromEntries(Object.entries(mysqlCb.Types).map(([k, v]) => [v, k]));

function parseMysqlLine(s) {
  const t = s.replace(/^->\s*/, '');
  const est = /\(cost=([\d.e+]+)(?:\.\.([\d.e+]+))? rows=([\d.e+]+)\)/.exec(t);
  const act = /\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.e+]+) loops=(\d+)\)/.exec(t);
  const label = t.replace(/\s*\((cost|actual)[^)]*\)/g, '').trim();
  const [head, ...rest] = label.split(/: /);
  return {
    label: head, detail: rest.join(': '),
    cost: est ? +(est[2] || est[1]) : undefined, rows: est ? +est[3] : undefined,
    actualRows: act ? +act[3] : undefined, time: act ? +act[2] * +act[4] : undefined, loops: act ? +act[4] : undefined,
    props: { line: t },
  };
}

module.exports = { MysqlDriver };
