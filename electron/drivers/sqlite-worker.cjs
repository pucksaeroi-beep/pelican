'use strict';
// SQLite runs synchronously, so it lives in a worker thread: a long query never freezes the window.
const { parentPort, workerData } = require('worker_threads');
process.removeAllListeners('warning');
process.on('warning', () => {});
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(workerData.file, { readOnly: !!workerData.readOnly, open: true });
let ro = null; // a second, read-only handle for MCP reads
const roDb = () => (workerData.file === ':memory:' ? db : (ro ||= new DatabaseSync(workerData.file, { readOnly: true })));

const ops = {
  query({ sql, params = [], maxRows = 1000, readOnly }) {
    const h = readOnly ? roDb() : db;
    const st = h.prepare(sql);
    st.setReturnArrays(true);
    const cols = st.columns();
    if (!cols.length) {
      const r = st.run(...params);
      return { columns: [], rows: [], affected: Number(r.changes), truncated: false, lastId: Number(r.lastInsertRowid) };
    }
    const rows = [];
    let truncated = false;
    for (const r of st.iterate(...params)) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(r);
    }
    return { columns: cols.map((c) => ({ name: c.name, type: (c.type || '').toLowerCase(), table: c.table || undefined })), rows, affected: null, truncated };
  },
  exec({ sql }) { db.exec(sql); return true; },
  /** Tables a statement reads or writes: OpenRead/OpenWrite root pages from its bytecode. */
  planTables({ sql }) {
    const pages = new Map();
    for (const dbr of db.prepare('PRAGMA database_list').all()) {
      const sch = dbr.name === 'temp' ? 'sqlite_temp_schema' : `"${dbr.name.replace(/"/g, '""')}".sqlite_schema`;
      try {
        for (const r of db.prepare(`select type, name, tbl_name, rootpage from ${sch}`).all()) if (r.rootpage) pages.set(dbr.seq + ':' + r.rootpage, { schema: dbr.name, table: r.tbl_name });
      } catch { /* skip */ }
    }
    const st = db.prepare('EXPLAIN ' + sql);
    const out = [];
    for (const r of st.all()) {
      if (r.opcode === 'OpenRead' || r.opcode === 'OpenWrite') {
        const t = pages.get(r.p3 + ':' + r.p2);
        if (t) out.push(t);
        else if (r.p2 === 1) out.push({ schema: 'main', table: 'sqlite_schema' });
      }
    }
    return out;
  },
  close() { db.close(); ro?.close(); return true; },
};

// dumps: post rows in chunks and wait for the main thread to ask for the next one (back-pressure)
const streams = new Map();
function streamNext(id) {
  const it = streams.get(id);
  if (!it) return;
  const rows = [];
  for (let i = 0; i < it.batch; i++) { const n = it.iter.next(); if (n.done) { streams.delete(id); break; } rows.push(n.value); }
  parentPort.postMessage({ id, chunk: rows, done: !streams.has(id) });
}

parentPort.on('message', ({ id, op, args }) => {
  if (op === 'stream') {
    try {
      const st = db.prepare(args.sql);
      st.setReturnArrays(true);
      streams.set(id, { iter: st.iterate(), batch: args.batch || 2000 });
      streamNext(id);
    } catch (e) { parentPort.postMessage({ id, error: e.message }); }
    return;
  }
  if (op === 'next') { streamNext(args.stream); return; }
  if (op === 'endStream') { streams.delete(args.stream); return; }
  try {
    const result = ops[op](args || {});
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
