'use strict';
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { cell } = require('./base.cjs');
const { quoteIdent, qualified } = require('../lib/sqltext.cjs');

class SqliteDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.dialect = 'sqlite';
    this.hasDatabases = false;
    this.seq = 0;
    this.waiting = new Map();
  }
  start() {
    const file = this.cfg.file;
    if (!file) throw new Error('Choose a database file.');
    if (file !== ':memory:' && !fs.existsSync(file) && this.cfg.readOnly) throw new Error(`File not found: ${file}`);
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    // worker scripts can't load from inside app.asar, so the packaged app keeps this one unpacked
    this.worker = new Worker(path.join(__dirname, 'sqlite-worker.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), { workerData: { file, readOnly: !!this.cfg.readOnly } });
    this.worker.on('message', (m) => {
      const w = this.waiting.get(m.id);
      if (!w) return;
      if (m.error) { this.waiting.delete(m.id); w.reject(new Error(m.error)); }
      else if (w.onChunk) { w.onChunk(m); if (m.done) this.waiting.delete(m.id); }
      else { this.waiting.delete(m.id); w.resolve(m.result); }
    });
    this.worker.on('error', (e) => { for (const w of this.waiting.values()) w.reject(e); this.waiting.clear(); });
    this.worker.on('exit', () => { for (const w of this.waiting.values()) w.reject(new Error('Query cancelled')); this.waiting.clear(); this.worker = null; });
  }
  call(op, args) {
    if (!this.worker) this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args });
    });
  }
  async connect() {
    const r = await this.call('query', { sql: 'select sqlite_version() as v' });
    this.version = 'SQLite ' + r.rows[0][0];
    return { version: this.version };
  }
  async close() { if (this.worker) { await this.call('close').catch(() => {}); await this.worker.terminate(); this.worker = null; } }
  async q(sql, params) {
    const r = await this.call('query', { sql, params, maxRows: 1e9 });
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
  }

  async databases() { return [null]; }
  async schemas() { return (await this.q('PRAGMA database_list')).map((r) => r.name).filter((n) => n !== 'temp'); }
  async objects(db, schema) {
    const rows = await this.q(`select name, type from ${quoteIdent(schema, 'sqlite')}.sqlite_schema where type in ('table','view') and name not like 'sqlite_%' order by name`);
    return rows.map((r) => ({ name: r.name, kind: r.type, sub: r.type, rows: null, size: null }));
  }
  async columns(db, schema, table) {
    const rows = await this.q(`select * from pragma_table_xinfo(?, ?)`, [table, schema]);
    return rows.filter((r) => r.hidden !== 1).map((r) => ({ name: r.name, type: r.type || '', nullable: !r.notnull, default: r.dflt_value, pk: r.pk > 0, comment: null }));
  }
  async indexes(db, schema, table) {
    const list = await this.q(`select * from pragma_index_list(?, ?)`, [table, schema]);
    const out = [];
    for (const ix of list) {
      const cols = await this.q(`select name from pragma_index_info(?, ?)`, [ix.name, schema]);
      const def = (await this.q(`select sql from ${quoteIdent(schema, 'sqlite')}.sqlite_schema where name = ?`, [ix.name]))[0]?.sql;
      out.push({ name: ix.name, unique: !!ix.unique, primary: ix.origin === 'pk', columns: cols.map((c) => c.name).join(', '), def: def || `(${ix.origin === 'pk' ? 'primary key' : 'automatic'})` });
    }
    return out;
  }
  async foreignKeys(db, schema, table) {
    const rows = await this.q(`select * from pragma_foreign_key_list(?, ?)`, [table, schema]);
    const by = new Map();
    for (const r of rows) { const k = r.id; if (!by.has(k)) by.set(k, { name: `fk_${k}`, ref_schema: schema, ref_table: r.table, from: [], to: [] }); by.get(k).from.push(r.from); by.get(k).to.push(r.to); }
    return [...by.values()].map((f) => ({ ...f, def: `(${f.from.join(', ')}) → ${f.ref_table}(${f.to.join(', ')})` }));
  }
  async ddl(db, schema, table) {
    const rows = await this.q(`select sql from ${quoteIdent(schema, 'sqlite')}.sqlite_schema where tbl_name = ? and sql is not null order by type = 'table' desc, type = 'view' desc, name`, [table]);
    return rows.map((r) => r.sql.trim() + ';').join('\n') + '\n';
  }

  async query(db, sql, params = [], { maxRows = 1000, readOnly = false, runId } = {}) {
    if (runId) this.runId = runId;
    try {
      const r = await this.call('query', { sql, params, maxRows, readOnly });
      return { ...r, rows: r.rows.map((row) => row.map(cell)), command: r.columns.length ? 'SELECT' : sql.trim().split(/\s+/)[0].toUpperCase() };
    } finally { if (this.runId === runId) this.runId = null; }
  }
  async cancel() { if (this.worker) await this.worker.terminate(); } // the next call starts a fresh worker
  async *stream(db, sql, batch = 2000) {
    if (!this.worker) this.start();
    const id = ++this.seq;
    let resolveNext;
    let pending = new Promise((r) => { resolveNext = r; });
    this.waiting.set(id, {
      reject: (e) => resolveNext({ error: e }),
      onChunk: (m) => resolveNext(m),
    });
    this.worker.postMessage({ id, op: 'stream', args: { sql, batch } });
    try {
      for (;;) {
        const m = await pending;
        if (m.error) throw m.error;
        pending = new Promise((r) => { resolveNext = r; });
        if (m.chunk.length) yield { rows: m.chunk, fields: [] };
        if (m.done) break;
        this.worker.postMessage({ id: -1, op: 'next', args: { stream: id } });
      }
    } finally {
      this.waiting.delete(id);
      this.worker?.postMessage({ id: -1, op: 'endStream', args: { stream: id } });
    }
  }
  async explain(db, sql) {
    const r = await this.call('query', { sql: 'EXPLAIN QUERY PLAN ' + sql, maxRows: 10000 });
    const nodes = new Map([[0, { label: 'QUERY PLAN', children: [], props: {} }]]);
    for (const [id, parent, , detail] of r.rows) {
      const m = /^(SCAN|SEARCH|USE TEMP B-TREE|COMPOUND QUERY|CO-ROUTINE|MATERIALIZE|SCALAR SUBQUERY|CORRELATED SCALAR SUBQUERY|LIST SUBQUERY|MULTI-INDEX OR|UNION ALL|LEFT-MOST SUBQUERY)\s*(.*)$/.exec(detail);
      const node = { label: m ? m[1] : detail, detail: m ? m[2] : '', children: [], props: { detail }, warn: /^SCAN\b/.test(detail) && !/COVERING INDEX|USING INDEX/.test(detail) };
      nodes.set(id, node);
      (nodes.get(parent) || nodes.get(0)).children.push(node);
    }
    const root = nodes.get(0);
    return { kind: 'sqlite', plan: root.children.length === 1 ? root.children[0] : root };
  }
  async planTables(db, sql) { return this.call('planTables', { sql }); }
  async tx(db, stmts) { return this.call('tx', { stmts: stmts.map((st) => ({ ...st, params: (st.params || []).map(sqliteParam) })) }); }
}

/** node:sqlite binds numbers, strings, bigints, buffers and null only. */
function sqliteParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}
module.exports = { SqliteDriver, qualified, sqliteParam };
