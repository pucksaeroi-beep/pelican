'use strict';
// Copy tables (structure, data, indexes) from one connection to another, e.g. from a shared server into a
// database on this Mac. SQL engines copy to any SQL engine (types are mapped); MongoDB copies to MongoDB.
//
// Rows are streamed from the source and written in batches of multi-row INSERTs, each batch in its own
// transaction, so memory stays flat however big the table is.
const { quoteIdent, qualified, placeholder } = require('./lib/sqltext.cjs');

const SQL = new Set(['pg', 'mysql', 'sqlite', 'db2']);
const MAX_PARAMS = { pg: 30000, mysql: 30000, sqlite: 30000, db2: 1000 };
const MAX_ROWS = { pg: 1000, mysql: 1000, sqlite: 500, db2: 100 };

// ---------------- types ----------------
/** What kind of value a column holds, from its type as the source engine writes it. */
function category(col, dialect) {
  const raw = String(col.type || '').trim();
  const t = raw.toLowerCase();
  const n = (re) => { const m = re.exec(t); return m ? m.slice(1).map((x) => (x == null ? null : +x)) : null; };
  if (t.endsWith('[]')) return { cat: 'array' };
  if (/^(bool|boolean)$/.test(t) || (dialect === 'mysql' && /^(tinyint\(1\)|bit\(1\))/.test(t))) return { cat: 'bool' };
  if (/^(tinyint|smallint|int2|smallserial)\b/.test(t)) return { cat: 'int', size: 2 };
  if (/^(bigint|int8|bigserial)\b/.test(t)) return { cat: 'int', size: 8 };
  if (/^(integer|int|int4|mediumint|serial|year)\b/.test(t)) return { cat: 'int', size: 4 };
  if (/^(numeric|decimal|dec|number)\b/.test(t)) { const m = n(/\((\d+)\s*(?:,\s*(\d+))?\)/); return { cat: 'dec', p: m?.[0] ?? null, s: m?.[1] ?? 0 }; }
  if (/^(decfloat|money)/.test(t)) return { cat: 'dec', p: t.startsWith('money') ? 19 : null, s: t.startsWith('money') ? 2 : 0 };
  if (/^(real|float4)$/.test(t) || /^float\(([1-9]|1\d|2[0-4])\)$/.test(t)) return { cat: 'float' };
  if (/^(double|float8|float|double precision)\b/.test(t)) return { cat: 'double' };
  if (/^(character varying|varchar|nvarchar|varchar2|nchar varying|vargraphic|varbinary)/.test(t) && !/binary|for bit data/.test(t)) { const m = n(/\((\d+)\)/); return m ? { cat: 'varchar', len: m[0] } : { cat: 'text' }; }
  if (/^(character|char|nchar|bpchar|graphic)\b/.test(t) && !/for bit data/.test(t)) { const m = n(/\((\d+)\)/); return { cat: 'char', len: m ? m[0] : 1 }; }
  if (/^(text|tinytext|mediumtext|longtext|clob|dbclob|nclob|citext|name|xml|long varchar|string)/.test(t)) return { cat: 'text' };
  if (/^(timestamp with time zone|timestamptz)/.test(t)) return { cat: 'tstz' };
  if (/^(timestamp|datetime)/.test(t)) return { cat: 'ts' };
  if (/^date$/.test(t)) return { cat: 'date' };
  if (/^(time|timetz|time with)/.test(t)) return { cat: 'time' };
  if (/^(json|jsonb)$/.test(t)) return { cat: 'json' };
  if (/^uuid$/.test(t)) return { cat: 'uuid' };
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|bit)/.test(t) || /for bit data/.test(t)) return { cat: 'bin' };
  if (dialect === 'sqlite') { // SQLite's affinity rules for anything else
    if (!t) return { cat: 'any' };
    if (/int/.test(t)) return { cat: 'int', size: 8 };
    if (/char|clob|text/.test(t)) return { cat: 'text' };
    if (/real|floa|doub/.test(t)) return { cat: 'double' };
    return { cat: 'dec', p: null, s: 0 };
  }
  return { cat: 'text' }; // enum, set, inet, interval, geometry…: kept as text
}

/** The column type to create on the target. */
function targetType(c, dst, { pk } = {}) {
  const { cat } = c;
  const intT = { pg: ['smallint', 'integer', 'bigint'], mysql: ['smallint', 'int', 'bigint'], sqlite: ['INTEGER', 'INTEGER', 'INTEGER'], db2: ['SMALLINT', 'INTEGER', 'BIGINT'] }[dst];
  const textT = { pg: 'text', mysql: pk ? 'varchar(255)' : 'longtext', sqlite: 'TEXT', db2: pk ? 'VARCHAR(1024)' : 'CLOB' }[dst];
  switch (cat) {
    case 'bool': return { pg: 'boolean', mysql: 'tinyint(1)', sqlite: 'BOOLEAN', db2: 'BOOLEAN' }[dst];
    case 'int': return intT[c.size === 2 ? 0 : c.size === 8 ? 2 : 1];
    case 'dec': {
      if (dst === 'sqlite') return 'NUMERIC';
      if (c.p == null) return { pg: 'numeric', mysql: 'decimal(65,30)', db2: 'DECFLOAT(34)' }[dst];
      const p = dst === 'db2' ? Math.min(c.p, 31) : dst === 'mysql' ? Math.min(c.p, 65) : c.p;
      return `${dst === 'pg' ? 'numeric' : 'DECIMAL'}(${p},${Math.min(c.s || 0, p)})`;
    }
    case 'float': return { pg: 'real', mysql: 'float', sqlite: 'REAL', db2: 'REAL' }[dst];
    case 'double': return { pg: 'double precision', mysql: 'double', sqlite: 'REAL', db2: 'DOUBLE' }[dst];
    case 'char': if (c.len > 254) return targetType({ ...c, cat: 'varchar' }, dst, { pk }); return dst === 'sqlite' ? `CHAR(${c.len})` : `${dst === 'pg' ? 'char' : 'CHAR'}(${dst === 'db2' ? Math.min(c.len * 4, 254) : c.len})`;
    case 'varchar': {
      if (dst === 'sqlite') return `VARCHAR(${c.len})`;
      if (dst === 'mysql') return c.len > 16000 ? textT : `varchar(${c.len})`;
      if (dst === 'db2') return c.len * 4 > 32672 ? textT : `VARCHAR(${c.len * 4})`; // Db2 counts bytes, UTF-8 needs up to 4
      return `varchar(${c.len})`;
    }
    case 'date': return dst === 'sqlite' ? 'DATE' : dst === 'pg' ? 'date' : 'DATE';
    case 'time': return { pg: 'time', mysql: 'time(6)', sqlite: 'TIME', db2: 'TIME' }[dst];
    case 'ts': return { pg: 'timestamp', mysql: 'datetime(6)', sqlite: 'DATETIME', db2: 'TIMESTAMP' }[dst];
    case 'tstz': return { pg: 'timestamptz', mysql: 'datetime(6)', sqlite: 'DATETIME', db2: 'TIMESTAMP' }[dst];
    case 'json': return { pg: 'jsonb', mysql: 'json', sqlite: 'TEXT', db2: 'CLOB' }[dst];
    case 'uuid': return { pg: 'uuid', mysql: 'char(36)', sqlite: 'TEXT', db2: 'CHAR(36)' }[dst];
    case 'bin': return { pg: 'bytea', mysql: 'longblob', sqlite: 'BLOB', db2: 'BLOB' }[dst];
    case 'any': return dst === 'sqlite' ? '' : textT;
    default: return textT;
  }
}

/** Is this column filled in by the database (serial, identity, auto_increment)? */
function isIdentity(col, dialect) {
  if (dialect === 'pg') return col.ident === 'a' || col.ident === 'd' || /^nextval\(/i.test(String(col.default || ''));
  if (dialect === 'mysql') return /auto_increment/i.test(col.extra || '');
  if (dialect === 'db2') return !!col.ident;
  return false;
}

/** A default the target can take as written: only between the same engine, never a sequence. */
function defaultClause(col, src, dst) {
  if (src !== dst || col.default == null || isIdentity(col, src)) return '';
  if (src === 'mysql') {
    const generated = /DEFAULT_GENERATED/i.test(col.extra || '');
    if (generated) return /^current_timestamp(\(\d*\))?$/i.test(col.default) ? ` DEFAULT ${col.default}` : ` DEFAULT (${col.default})`;
    return ` DEFAULT '${String(col.default).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
  }
  return ` DEFAULT ${col.default}`;
}

function createTableSql({ src, dst, schema, table, cols, keepDefaults = true, mapTypes = src !== dst }) {
  const q = (n) => quoteIdent(n, dst);
  const pk = cols.filter((c) => c.pk);
  const inlinePk = dst === 'sqlite' && pk.length === 1 && (pk[0].c.cat === 'int' || (src === 'sqlite' && /^integer$/i.test(pk[0].type)));
  const lines = cols.map((c) => {
    if (inlinePk && c.pk) return `  ${q(c.to)} INTEGER PRIMARY KEY`;
    const type = mapTypes ? targetType(c.c, dst, { pk: c.pk }) : c.type;
    let s = `  ${q(c.to)}${type ? ' ' + type : ''}`;
    if (c.identity && c.c.cat === 'int') {
      if (dst === 'pg' || dst === 'db2') s += ' GENERATED BY DEFAULT AS IDENTITY';
      else if (dst === 'mysql') s += ' AUTO_INCREMENT';
    } else if (keepDefaults) s += defaultClause(c, src, dst);
    if (!c.nullable || c.pk) s += ' NOT NULL';
    return s;
  });
  if (pk.length && !inlinePk) lines.push(`  PRIMARY KEY (${pk.map((c) => q(c.to)).join(', ')})`);
  return `CREATE TABLE ${qualified(schema, table, dst)} (\n${lines.join(',\n')}\n)`;
}

// ---------------- values ----------------
const pad = (n, w = 2) => String(n).padStart(w, '0');
function utcText(d, frac) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac ? '.' + frac : ''}`; }

/** A value as the source streamed it → a parameter the target accepts. */
function convert(v, c, src, dst) {
  if (v === null || v === undefined) return null;
  if (src !== dst) {
    switch (c.cat) {
      case 'bool': {
        const b = typeof v === 'string' ? /^(t|true|1|y|yes|on)$/i.test(v.trim()) : Buffer.isBuffer(v) ? v[0] !== 0 : !!Number(v);
        return dst === 'pg' || dst === 'db2' ? b : b ? 1 : 0;
      }
      case 'bin':
        if (typeof v === 'string' && src === 'pg' && v.startsWith('\\x')) return Buffer.from(v.slice(2), 'hex');
        if (v instanceof Uint8Array) return Buffer.from(v);
        return v;
      case 'tstz':
        if (typeof v === 'string' && dst !== 'pg') {
          const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d+))?([+-]\d\d(?::?\d\d)?|Z)?$/.exec(v.trim());
          if (m && m[4]) { const d = new Date(`${m[1]}T${m[2]}${m[4] === 'Z' ? 'Z' : m[4].length === 3 ? m[4] + ':00' : m[4].includes(':') ? m[4] : m[4].slice(0, 3) + ':' + m[4].slice(3)}`); if (!isNaN(d)) return utcText(d, m[3]); }
        }
        return v;
      case 'ts':
        if (typeof v === 'string') { const m = /^(\d{4}-\d\d-\d\d)-(\d\d)\.(\d\d)\.(\d\d)(\.\d+)?$/.exec(v); if (m) return `${m[1]} ${m[2]}:${m[3]}:${m[4]}${m[5] || ''}`; } // Db2's own form
        return v;
      case 'time':
        if (typeof v === 'string' && /^\d\d\.\d\d\.\d\d$/.test(v)) return v.replace(/\./g, ':');
        return v;
      default: break;
    }
  }
  if (typeof v === 'bigint') return dst === 'sqlite' ? v : v.toString();
  if (typeof v === 'boolean') return dst === 'sqlite' || dst === 'mysql' ? (v ? 1 : 0) : v;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().replace('T', ' ').replace('Z', '');
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

// ---------------- names ----------------
function nameFor(name, src, dst, adapt) {
  if (!adapt) return name;
  if (dst === 'db2' && src !== 'db2' && /^[a-z_][a-z0-9_]*$/.test(name)) return name.toUpperCase();
  if (src === 'db2' && dst !== 'db2' && /^[A-Z_][A-Z0-9_]*$/.test(name)) return name.toLowerCase();
  return name;
}
const sameName = (a, b, dialect) => (dialect === 'mysql' || dialect === 'sqlite' ? a.toLowerCase() === b.toLowerCase() : a === b);

// ---------------- run ----------------
/**
 * o: { items: [{ schema, table }], srcDb, dstDb, dstSchema ('' = same name as the source schema),
 *      ifExists: 'fail' | 'drop' | 'truncate' | 'append', structure, data, indexes, adaptCase }
 */
async function runTransfer({ src, dst, o, progress, signal }) {
  const sd = src.driver.dialect;
  const dd = dst.driver.dialect;
  if ((sd === 'mongo') !== (dd === 'mongo')) throw new Error('MongoDB collections copy to MongoDB only, and SQL tables to SQL databases.');
  const items = o.items || [];
  if (!items.length) throw new Error('Pick at least one table.');
  const plan = items.map((it) => {
    let schema = o.dstSchema || (dd === 'sqlite' ? 'main' : nameFor(it.schema, sd, dd, o.adaptCase));
    if (dd === 'sqlite') schema = 'main';
    return { ...it, toSchema: schema, toTable: nameFor(it.table, sd, dd, o.adaptCase) };
  });
  if (src.id === dst.id && (o.srcDb || '') === (o.dstDb || '')) {
    for (const p of plan) if (sameName(p.schema, p.toSchema, dd) && sameName(p.table, p.toTable, dd)) throw new Error(`“${p.schema}.${p.table}” would be copied onto itself. Pick another target schema.`);
  }
  const summary = { tables: 0, rows: 0, errors: 0, warnings: [] };
  const ensured = new Map(); // target schema → names of its tables
  const t0 = performance.now();

  async function tablesIn(schema) {
    if (!ensured.has(schema)) {
      const schemas = await dst.driver.schemas(o.dstDb, { system: true }).catch(() => []);
      if (dd !== 'sqlite' && !schemas.some((s) => sameName(s, schema, dd))) {
        if (dd === 'mongo') { /* created on the first insert */ } else {
          await dst.driver.query(o.dstDb, dd === 'mysql' ? `CREATE DATABASE ${quoteIdent(schema, dd)}` : `CREATE SCHEMA ${quoteIdent(schema, dd)}`, []);
          summary.warnings.push(`Created ${dd === 'mysql' ? 'database' : 'schema'} ${schema}`);
        }
      }
      ensured.set(schema, new Set((await dst.driver.objects(o.dstDb, schema).catch(() => [])).map((x) => x.name)));
    }
    return ensured.get(schema);
  }

  for (const p of plan) {
    if (signal.aborted) break;
    const key = `${p.schema}\u0000${p.table}`;
    const report = (patch) => progress({ key, schema: p.schema, table: p.table, to: `${dd === 'sqlite' ? '' : p.toSchema + '.'}${p.toTable}`, ...patch });
    report({ status: 'running', rows: 0 });
    try {
      const r = sd === 'mongo' ? await copyCollection(src, dst, o, p, tablesIn, (n) => report({ status: 'running', rows: n }), signal)
        : await copyTable(src, dst, o, p, tablesIn, (n) => report({ status: 'running', rows: n }), signal, summary);
      summary.tables++; summary.rows += r.rows;
      report({ status: signal.aborted ? 'cancelled' : 'done', rows: r.rows, notes: r.notes });
    } catch (e) {
      summary.errors++;
      report({ status: 'error', error: e.message });
    }
  }
  return { ...summary, cancelled: signal.aborted, ms: Math.round(performance.now() - t0) };
}

async function copyTable(src, dst, o, p, tablesIn, onRows, signal) {
  const sd = src.driver.dialect;
  const dd = dst.driver.dialect;
  const notes = [];
  const srcCols = await src.driver.columns(o.srcDb, p.schema, p.table);
  if (!srcCols.length) throw new Error('No columns found.');
  const cols = srcCols.map((c) => ({ ...c, to: nameFor(c.name, sd, dd, o.adaptCase), c: category(c, sd), identity: isIdentity(c, sd) || (sd === 'sqlite' && c.pk && srcCols.filter((x) => x.pk).length === 1 && /^integer$/i.test(c.type)) }));
  const target = qualified(p.toSchema, p.toTable, dd);
  const existing = await tablesIn(p.toSchema);
  const exists = [...existing].some((n) => sameName(n, p.toTable, dd));

  if (exists) {
    if (o.ifExists === 'fail' || !o.ifExists) throw new Error(`${p.toTable} already exists on the target. Choose “Drop and recreate”, “Empty it first” or “Add rows”.`);
    if (o.ifExists === 'drop') { await dst.driver.query(o.dstDb, `DROP TABLE ${target}`, []); existing.delete(p.toTable); }
    else if (o.ifExists === 'truncate') await dst.driver.query(o.dstDb, dd === 'pg' || dd === 'mysql' ? `TRUNCATE TABLE ${target}` : `DELETE FROM ${target}`, []);
  }
  const created = !exists || o.ifExists === 'drop';
  if (created) {
    if (o.structure === false) throw new Error(`${p.toTable} does not exist on the target and “Create tables” is off.`);
    // between the same engine, types and defaults are copied as written; if the target lacks something
    // they use (a custom type, a function), try again without defaults, then with plain mapped types
    const tries = sd === dd ? [{}, { keepDefaults: false }, { keepDefaults: false, mapTypes: true }] : [{}];
    for (let i = 0; i < tries.length; i++) {
      try { await dst.driver.query(o.dstDb, createTableSql({ src: sd, dst: dd, schema: p.toSchema, table: p.toTable, cols, ...tries[i] }), []); break; }
      catch (e) {
        if (i === tries.length - 1) throw e;
        if (i === 0) notes.push('column defaults left out (' + e.message + ')');
        else notes.push('column types mapped to standard ones (' + e.message + ')');
      }
    }
    existing.add(p.toTable);
  }

  let rows = 0;
  if (o.data !== false) {
    const per = Math.max(1, Math.min(MAX_ROWS[dd], Math.floor(MAX_PARAMS[dd] / cols.length)));
    const head = `INSERT INTO ${target} (${cols.map((c) => quoteIdent(c.to, dd)).join(', ')}) VALUES `;
    const flush = async (batch) => {
      const params = [];
      const tuples = batch.map((r) => '(' + cols.map((c, i) => {
        const v = convert(r[i], c.c, sd, dd);
        params.push(dd === 'db2' && c.c.cat === 'bin' ? { ParamType: 'INPUT', DataType: 'BLOB', Data: v == null ? null : Buffer.from(v) } : v); // Db2 needs the type of a binary value, even a NULL one
        return placeholder(dd, params.length);
      }).join(', ') + ')');
      await dst.driver.tx(o.dstDb, [{ sql: head + tuples.join(', '), params }]);
      rows += batch.length;
      onRows(rows);
    };
    const select = `SELECT ${cols.map((c) => quoteIdent(c.name, sd)).join(', ')} FROM ${qualified(p.schema, p.table, sd)}`;
    let buf = [];
    for await (const chunk of src.driver.stream(o.srcDb, select, 2000)) {
      if (signal.aborted) break;
      for (const r of chunk.rows) { buf.push(r); if (buf.length >= per) { await flush(buf); buf = []; if (signal.aborted) break; } }
    }
    if (buf.length && !signal.aborted) await flush(buf);
    if (!signal.aborted && rows) await resetIdentity(dst, o.dstDb, dd, p, cols, target).catch((e) => notes.push('identity counter not moved on: ' + e.message));
  }

  if (o.indexes !== false && created && !signal.aborted) {
    const idx = await src.driver.indexes(o.srcDb, p.schema, p.table).catch(() => []);
    const byName = new Map(cols.map((c) => [c.name.toLowerCase(), c]));
    for (const ix of idx) {
      if (ix.primary) continue;
      const parts = String(ix.columns || '').split(',').map((s) => s.trim().replace(/^["`]|["`]$/g, '')).filter(Boolean);
      const mapped = parts.map((n) => byName.get(n.toLowerCase()));
      if (!parts.length || mapped.some((c) => !c)) { notes.push(`index ${ix.name} skipped (uses an expression)`); continue; }
      if (dd === 'mysql' && mapped.some((c) => ['text', 'json', 'bin', 'array'].includes(c.c.cat) && sd !== 'mysql')) { notes.push(`index ${ix.name} skipped (MySQL cannot index long text)`); continue; }
      if (dd === 'db2' && mapped.some((c) => ['text', 'json', 'bin', 'array'].includes(c.c.cat) && sd !== 'db2')) { notes.push(`index ${ix.name} skipped (Db2 cannot index CLOB / BLOB)`); continue; }
      const cl = mapped.map((c) => quoteIdent(c.to, dd)).join(', ');
      const name = nameFor(ix.name, sd, dd, o.adaptCase);
      const make = (n) => `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${dd === 'sqlite' || dd === 'mysql' ? quoteIdent(n, dd) : dd === 'db2' ? qualified(p.toSchema, n, dd) : quoteIdent(n, dd)} ON ${target} (${cl})`;
      try { await dst.driver.query(o.dstDb, make(name), []); }
      catch {
        try { await dst.driver.query(o.dstDb, make(`${p.toTable}_${name}`.slice(0, 120)), []); }
        catch (e2) { notes.push(`index ${ix.name}: ${e2.message}`); }
      }
    }
  }
  return { rows, notes };
}

/** After copying ids in, the target's own counter has to start after the highest one. */
async function resetIdentity(dst, db, dd, p, cols, target) {
  const id = cols.find((c) => c.identity && c.c.cat === 'int');
  if (!id) return;
  const q = quoteIdent(id.to, dd);
  if (dd === 'pg') {
    await dst.driver.query(db, `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${q}) FROM ${target}), 1))`, [target, id.to]);
  } else if (dd === 'db2') {
    const r = await dst.driver.query(db, `SELECT COALESCE(MAX(${q}), 0) + 1 FROM ${target}`, []);
    await dst.driver.query(db, `ALTER TABLE ${target} ALTER COLUMN ${q} RESTART WITH ${Number(r.rows[0][0]) | 0}`, []);
  }
}

async function copyCollection(src, dst, o, p, tablesIn, onRows, signal) {
  const notes = [];
  const existing = await tablesIn(p.toSchema);
  const target = dst.driver.client.db(p.toSchema);
  const exists = existing.has(p.toTable);
  if (exists) {
    if (o.ifExists === 'fail' || !o.ifExists) throw new Error(`${p.toTable} already exists on the target. Choose “Drop and recreate”, “Empty it first” or “Add rows”.`);
    if (o.ifExists === 'drop') await target.collection(p.toTable).drop();
    else if (o.ifExists === 'truncate') await target.collection(p.toTable).deleteMany({});
  }
  const created = !exists || o.ifExists === 'drop';
  if (created) { await target.createCollection(p.toTable).catch(() => {}); existing.add(p.toTable); }
  let rows = 0;
  if (o.data !== false) {
    for await (const chunk of src.driver.stream(o.srcDb, p.table, 1000, p.schema)) {
      if (signal.aborted) break;
      await target.collection(p.toTable).insertMany(chunk.docs, { ordered: true });
      rows += chunk.docs.length;
      onRows(rows);
    }
  }
  if (o.indexes !== false && created && !signal.aborted) {
    const list = await src.driver.client.db(p.schema).collection(p.table).indexes().catch(() => []);
    for (const ix of list) {
      if (ix.name === '_id_') continue;
      const { key, v, ns, ...opts } = ix;
      try { await target.collection(p.toTable).createIndex(key, opts); } catch (e) { notes.push(`index ${ix.name}: ${e.message}`); }
    }
  }
  return { rows, notes };
}

module.exports = { runTransfer, category, targetType, createTableSql, convert, nameFor, SQL };
