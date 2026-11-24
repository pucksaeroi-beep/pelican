'use strict';
// IBM Db2 (LUW) through ibm_db, which bundles IBM's CLI driver.
const { cell, Queue } = require('./base.cjs');
const { statementKind, quoteIdent, qualified } = require('../lib/sqltext.cjs');

let ibmdb;
const load = () => (ibmdb ||= require('ibm_db'));
const SYSTEM = /^(SYS\w*|NULLID|SQLJ|DB2GSE|DB2INST\d*_?SYS|ERRORSCHEMA)$/i;

class Db2Driver {
  constructor(cfg) {
    this.cfg = cfg;
    this.dialect = 'db2';
    this.hasDatabases = false;
    this.queue = new Queue();
  }
  connStr() {
    const c = this.cfg;
    const esc = (v) => (/[;{}]/.test(String(v)) ? `{${String(v).replace(/}/g, '}}')}}` : String(v));
    return `DATABASE=${esc(c.database || 'SAMPLE')};HOSTNAME=${esc(c.host || '127.0.0.1')};PORT=${+c.port || 50000};PROTOCOL=TCPIP;UID=${esc(c.user || 'db2inst1')};PWD=${esc(c.password || '')};ConnectTimeout=10;${c.ssl && c.ssl !== 'disable' ? 'Security=SSL;' : ''}`;
  }
  async connect() {
    this.conn = await load().open(this.connStr());
    let v = '';
    try { v = this.conn.getInfoSync(18); } catch { /* SQL_DBMS_VER not available */ } // e.g. "11.05.0900"
    this.version = 'Db2 ' + (v ? v.replace(/^0?(\d+)\.0?(\d+)\.0*(\d+?)0*$/, (m, a, b, c) => `${a}.${b}.${c}`) : '');
    return { version: this.version };
  }
  async close() { if (this.conn) await this.conn.close().catch(() => {}); this.conn = null; }
  rows(sql, params = []) { return this.queue.run(() => this.conn.query(sql, params)); }
  /** Unqualified names resolve in `schema` (or the user's own schema). Call inside the queue. */
  async useSchema(schema) {
    const want = schema || null;
    if (this.curSchema === want) return;
    await this.conn.query(want ? `SET SCHEMA ${quoteIdent(want, 'db2')}` : 'SET SCHEMA = USER');
    this.curSchema = want;
  }

  async databases() { return [null]; }
  async schemas(db, { system } = {}) {
    const r = await this.rows(`SELECT RTRIM(SCHEMANAME) AS NAME FROM SYSCAT.SCHEMATA ORDER BY SCHEMANAME`);
    const user = String(this.cfg.user || '').toUpperCase();
    const names = r.map((x) => x.NAME).filter((n) => system || !SYSTEM.test(n));
    return names.includes(user) ? [user, ...names.filter((n) => n !== user)] : names;
  }
  async objects(db, schema) {
    const r = await this.rows(`SELECT RTRIM(TABNAME) AS NAME, TYPE, CARD, REMARKS FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE IN ('T','V','S','N','G') ORDER BY TABNAME`, [schema]);
    return r.map((x) => ({ name: x.NAME, kind: x.TYPE === 'V' ? 'view' : 'table', sub: { T: 'table', V: 'view', S: 'materialized query table', N: 'nickname', G: 'temporary table' }[x.TYPE], rows: x.CARD >= 0 ? +x.CARD : null, size: null, comment: x.REMARKS || null }));
  }
  async columns(db, schema, table) {
    const r = await this.rows(`SELECT RTRIM(C.COLNAME) AS NAME, C.TYPENAME, C.LENGTH, C.SCALE, C.NULLS, C."DEFAULT" AS DEF, C.REMARKS, C.KEYSEQ, C.IDENTITY
      FROM SYSCAT.COLUMNS C WHERE C.TABSCHEMA = ? AND C.TABNAME = ? ORDER BY C.COLNO`, [schema, table]);
    return r.map((x) => ({ name: x.NAME, type: db2Type(x), nullable: x.NULLS === 'Y', default: x.DEF, pk: x.KEYSEQ != null, comment: x.REMARKS || null, ident: x.IDENTITY === 'Y' }));
  }
  async indexes(db, schema, table) {
    const r = await this.rows(`SELECT RTRIM(INDNAME) AS NAME, UNIQUERULE, COLNAMES FROM SYSCAT.INDEXES WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY UNIQUERULE = 'P' DESC, INDNAME`, [schema, table]).catch(() => this.rows(`SELECT RTRIM(INDNAME) AS NAME, UNIQUERULE, COLNAMES FROM SYSCAT.INDEXES WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY INDNAME`, [schema, table]));
    return r.map((x) => ({ name: x.NAME, unique: x.UNIQUERULE !== 'D', primary: x.UNIQUERULE === 'P', columns: String(x.COLNAMES).replace(/^[+-]/, '').split(/[+-]/).join(', '), def: x.COLNAMES }));
  }
  async foreignKeys(db, schema, table) {
    const r = await this.rows(`SELECT RTRIM(CONSTNAME) AS NAME, RTRIM(REFTABSCHEMA) AS RS, RTRIM(REFTABNAME) AS RT, FK_COLNAMES, PK_COLNAMES FROM SYSCAT.REFERENCES WHERE TABSCHEMA = ? AND TABNAME = ?`, [schema, table]);
    return r.map((x) => ({ name: x.NAME, ref_schema: x.RS, ref_table: x.RT, def: `(${x.FK_COLNAMES.trim().split(/\s+/).join(', ')}) → ${x.RT}(${x.PK_COLNAMES.trim().split(/\s+/).join(', ')})` }));
  }
  async fkDdl(db, schema, table) {
    const r = await this.rows(`SELECT RTRIM(CONSTNAME) AS NAME, RTRIM(REFTABSCHEMA) AS RS, RTRIM(REFTABNAME) AS RT, FK_COLNAMES, PK_COLNAMES FROM SYSCAT.REFERENCES WHERE TABSCHEMA = ? AND TABNAME = ?`, [schema, table]);
    const cols = (s) => s.trim().split(/\s+/).map((c) => quoteIdent(c, 'db2')).join(', ');
    return r.map((x) => `ALTER TABLE ${qualified(schema, table, 'db2')} ADD CONSTRAINT ${quoteIdent(x.NAME, 'db2')} FOREIGN KEY (${cols(x.FK_COLNAMES)}) REFERENCES ${qualified(x.RS, x.RT, 'db2')} (${cols(x.PK_COLNAMES)});`);
  }
  async ddl(db, schema, table) {
    const t = await this.rows(`SELECT TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TABNAME = ?`, [schema, table]);
    const name = qualified(schema, table, 'db2');
    if (t[0]?.TYPE === 'V') {
      const v = await this.rows(`SELECT TEXT FROM SYSCAT.VIEWS WHERE VIEWSCHEMA = ? AND VIEWNAME = ?`, [schema, table]);
      return String(v[0]?.TEXT || '').trim() + ';\n';
    }
    const cols = await this.columns(db, schema, table);
    const lines = cols.map((c) => `  ${quoteIdent(c.name, 'db2')} ${c.type}${c.ident ? ' GENERATED BY DEFAULT AS IDENTITY' : c.default != null ? ` DEFAULT ${c.default}` : ''}${c.nullable ? '' : ' NOT NULL'}`);
    const pk = cols.filter((c) => c.pk).map((c) => quoteIdent(c.name, 'db2'));
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);
    let out = `CREATE TABLE ${name} (\n${lines.join(',\n')}\n);\n`;
    for (const ix of await this.indexes(db, schema, table)) if (!ix.primary) {
      const cs = String(ix.def).match(/[+-][^+-]+/g) || [];
      out += `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(schema, 'db2')}.${quoteIdent(ix.name, 'db2')} ON ${name} (${cs.map((c) => quoteIdent(c.slice(1), 'db2') + (c[0] === '-' ? ' DESC' : '')).join(', ')});\n`;
    }
    return out;
  }

  async query(db, sql, params = [], { maxRows = 1000, schema } = {}) {
    return this.queue.run(async () => {
      await this.useSchema(schema);
      const stmt = await this.conn.prepare(sql);
      this.stmt = stmt;
      try {
        if (statementKind(sql, 'db2') !== 'read') {
          const n = await stmt.executeNonQuery(params);
          return { columns: [], rows: [], affected: n, truncated: false, command: sql.trim().split(/\s+/)[0].toUpperCase() };
        }
        const res = await stmt.execute(params);
        try {
          const meta = res.getColumnMetadataSync() || [];
          const rows = await res.fetchN(maxRows + 1, { fetchMode: 3 });
          const truncated = rows.length > maxRows;
          if (truncated) rows.length = maxRows;
          return { columns: meta.map((m) => ({ name: m.SQL_DESC_NAME, type: String(m.SQL_DESC_TYPE_NAME || '').toLowerCase() })), rows: rows.map((r) => r.map(cell)), affected: null, truncated, command: 'SELECT' };
        } finally { res.closeSync(); }
      } finally { this.stmt = null; stmt.closeSync(); }
    });
  }
  async cancel() { if (this.stmt) await this.conn.cancel(this.stmt).catch(() => {}); }
  async *stream(db, sql, batch = 2000) {
    // a second connection so the UI stays usable during a long dump
    const conn = await load().open(this.connStr());
    try {
      const stmt = await conn.prepare(sql);
      const res = await stmt.execute([]);
      const fields = (res.getColumnMetadataSync() || []).map((m) => ({ name: m.SQL_DESC_NAME }));
      for (;;) {
        const rows = await res.fetchN(batch, { fetchMode: 3 });
        if (!rows.length) break;
        yield { rows, fields };
      }
      res.closeSync(); stmt.closeSync();
    } finally { await conn.close().catch(() => {}); }
  }

  async explain(db, sql, { schema } = {}) {
    return this.queue.run(async () => {
      const c = this.conn;
      await this.useSchema(schema);
      const x = await explainOwner(c);
      await c.query(`DELETE FROM ${x}.EXPLAIN_INSTANCE WHERE EXPLAIN_REQUESTER = CURRENT USER`);
      await c.query(`EXPLAIN PLAN FOR ${sql}`);
      const ops = await c.query(`SELECT OPERATOR_ID AS ID, RTRIM(OPERATOR_TYPE) AS T, TOTAL_COST AS COST, IO_COST FROM ${x}.EXPLAIN_OPERATOR ORDER BY OPERATOR_ID`);
      const streams = await c.query(`SELECT SOURCE_ID AS S, TARGET_ID AS T, STREAM_COUNT AS N, RTRIM(OBJECT_SCHEMA) AS OS, RTRIM(OBJECT_NAME) AS OBJ FROM ${x}.EXPLAIN_STREAM`);
      const nodes = new Map(ops.map((o) => [o.ID, { label: o.T, detail: '', cost: +o.COST, rows: undefined, props: { 'Operator ID': o.ID, 'I/O cost': o.IO_COST }, children: [] }]));
      let root = null;
      for (const s of streams) {
        const target = nodes.get(s.T);
        if (s.S > 0 && target) { const src = nodes.get(s.S); if (src) { src.rows = Math.round(s.N); target.children.push(src); } }
        if (s.S < 0 && target && s.OBJ) target.detail = target.detail ? `${target.detail}, ${s.OS}.${s.OBJ}` : `${s.OS}.${s.OBJ}`;
        if (s.T < 0 || s.T == null) root = nodes.get(s.S) || root;
      }
      root = root || nodes.get(1) || { label: 'Plan', children: [], props: {} };
      return { kind: 'db2', plan: root };
    });
  }
  /** Db2 has no cheap way to list a statement's tables, so read them from the explain tables. */
  async planTables(db, sql, { schema } = {}) {
    return this.queue.run(async () => {
      const c = this.conn;
      await this.useSchema(schema);
      const x = await explainOwner(c);
      await c.query(`DELETE FROM ${x}.EXPLAIN_INSTANCE WHERE EXPLAIN_REQUESTER = CURRENT USER`);
      await c.query(`EXPLAIN PLAN FOR ${sql}`);
      const objs = await c.query(`SELECT DISTINCT RTRIM(OBJECT_SCHEMA) AS S, RTRIM(OBJECT_NAME) AS T, OBJECT_TYPE AS K FROM ${x}.EXPLAIN_OBJECT`);
      const out = [];
      for (const o of objs) {
        if (o.K === 'TA') out.push({ schema: o.S, table: o.T });
        else if (o.K === 'IX') {
          const ix = await c.query(`SELECT RTRIM(TABSCHEMA) AS S, RTRIM(TABNAME) AS T FROM SYSCAT.INDEXES WHERE INDSCHEMA = ? AND INDNAME = ?`, [o.S, o.T]);
          if (ix[0]) out.push({ schema: ix[0].S, table: ix[0].T });
        }
      }
      return out;
    });
  }
}

/** Schema of this user's explain tables (created the first time), quoted for SQL. */
async function explainOwner(c) {
  const u = String((await c.query('SELECT RTRIM(CURRENT USER) AS U FROM SYSIBM.SYSDUMMY1'))[0].U);
  const has = await c.query(`SELECT 1 AS X FROM SYSCAT.TABLES WHERE TABNAME = 'EXPLAIN_OBJECT' AND TABSCHEMA = ?`, [u]);
  if (!has.length) await installExplain(c);
  return quoteIdent(u, 'db2');
}

/** Db2 keeps plans in EXPLAIN_* tables; create them for this user the first time. */
async function installExplain(c) {
  try {
    await c.query(`CALL SYSPROC.SYSINSTALLOBJECTS('EXPLAIN', 'C', CAST(NULL AS VARCHAR(128)), CURRENT USER)`);
  } catch (e) {
    throw new Error(`Db2 has no explain tables for this user and could not create them (${String(e.message).replace(/^\[[^\]]*\]\s*/g, '').slice(0, 160)}). Create them once on the server with: db2 connect to <db> && db2 -tf ~/sqllib/misc/EXPLAIN.DDL`);
  }
}

function db2Type(x) {
  const t = x.TYPENAME;
  if (/^(VARCHAR|CHARACTER|CHAR|VARGRAPHIC|GRAPHIC|BINARY|VARBINARY)$/.test(t)) return `${t === 'CHARACTER' ? 'CHAR' : t}(${x.LENGTH})`;
  if (t === 'DECIMAL') return `DECIMAL(${x.LENGTH}, ${x.SCALE})`;
  if (/^(CLOB|BLOB|DBCLOB)$/.test(t)) return `${t}(${x.LENGTH})`;
  return t;
}

module.exports = { Db2Driver };
