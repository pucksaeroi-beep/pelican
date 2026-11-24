'use strict';
// Dumps: a whole database, some schemas, or picked tables; structure, data, or both.
//
// Speed and stability come from the official dump tools (pg_dump, mysqldump, mongodump — all written in C)
// when they are installed. Otherwise Pelican's built-in dumper streams rows with back-pressure, so memory stays
// flat however big the table is; the database and the disk are the bottleneck, not JavaScript.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { spawn, execFileSync } = require('child_process');
const { quoteIdent, qualified, literal } = require('./lib/sqltext.cjs');

// ---------- finding native tools ----------
const EXTRA_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/opt/libpq/bin', '/opt/homebrew/opt/mysql-client/bin', '/opt/homebrew/opt/mysql/bin',
  '/opt/homebrew/opt/mongodb-database-tools/bin', '/usr/local/bin', '/usr/local/mysql/bin', '/usr/local/opt/libpq/bin', '/usr/local/opt/mysql-client/bin'];

function postgresAppDirs() {
  const base = '/Applications/Postgres.app/Contents/Versions';
  try {
    return fs.readdirSync(base).filter((v) => /^\d+(\.\d+)?$/.test(v)).sort((a, b) => parseFloat(b) - parseFloat(a)).map((v) => path.join(base, v, 'bin'));
  } catch { return []; }
}
function findTools(name) {
  const dirs = [...(process.env.PATH || '').split(':'), ...(name.startsWith('pg_') ? postgresAppDirs() : []), ...EXTRA_DIRS];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    const f = path.join(d, name);
    if (!d || seen.has(f)) continue;
    seen.add(f);
    try { fs.accessSync(f, fs.constants.X_OK); out.push(f); } catch { /* not here */ }
  }
  return out;
}
function toolVersion(file) {
  try { return execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 4000 }).trim(); } catch { return ''; }
}
/** The best native tool for this connection, or null with a reason. */
async function nativeTool(type, driver) {
  if (type === 'postgres') {
    const server = +(await driver.q(null, 'show server_version_num')).rows[0].server_version_num;
    const major = Math.floor(server / 10000);
    for (const f of findTools('pg_dump')) {
      const v = toolVersion(f);
      const m = /(\d+)(?:\.(\d+))?/.exec(v);
      if (m && +m[1] >= major) return { file: f, version: v };
    }
    return { file: null, reason: `pg_dump ${major} or newer was not found (Postgres.app or \`brew install libpq\` provides it).` };
  }
  if (type === 'mysql') {
    const f = findTools('mysqldump')[0] || findTools('mariadb-dump')[0];
    return f ? { file: f, version: toolVersion(f) } : { file: null, reason: 'mysqldump was not found (`brew install mysql-client`).' };
  }
  if (type === 'mongo') {
    const f = findTools('mongodump')[0];
    return f ? { file: f, version: toolVersion(f) } : { file: null, reason: 'mongodump was not found (`brew install mongodb-database-tools`).' };
  }
  return { file: null, reason: 'No native dump tool for this database; the built-in dumper is used.' };
}

async function toolsStatus() {
  const one = (n) => { const f = findTools(n)[0]; return f ? { file: f, version: toolVersion(f) } : null; };
  return { pg_dump: one('pg_dump'), mysqldump: one('mysqldump') || one('mariadb-dump'), mongodump: one('mongodump') };
}

// ---------- running ----------
/**
 * opts: { db, scope: 'database'|'schemas'|'tables', schemas: [], tables: [{schema, table}], content: 'all'|'schema'|'data',
 *         engine: 'auto'|'native'|'builtin', out, gzip, dropIfExists, noOwner, dataFormat: 'insert'|'copy', batch, pgFormat: 'plain'|'custom' }
 * progress(evt): { message?, table?, rows?, tablesDone?, tablesTotal?, bytes? }
 */
async function runDump({ cfg, driver }, opts, progress, signal) {
  const started = Date.now();
  let engine = opts.engine || 'auto';
  if (engine !== 'builtin' && ['postgres', 'mysql', 'mongo'].includes(cfg.type)) {
    const tool = await nativeTool(cfg.type, driver);
    if (tool.file && !(cfg.type === 'mongo' && opts.content === 'schema')) {
      progress({ message: `Using ${path.basename(tool.file)} — ${tool.version.split('\n')[0]}` });
      await runNative(cfg, tool.file, opts, progress, signal);
      return finish(opts.out, started, 'native', progress);
    }
    if (engine === 'native') throw new Error(tool.reason || 'Native dump tool unavailable.');
    progress({ message: (tool.reason || '') + ' Using the built-in dumper.' });
  }
  if (cfg.type === 'mongo') await builtinMongo(driver, opts, progress, signal);
  else await builtinSql(cfg, driver, opts, progress, signal);
  return finish(opts.out, started, 'builtin', progress);
}
function finish(out, started, engine, progress) {
  let bytes = 0;
  try { bytes = fs.statSync(out).size; } catch { /* folder output */ }
  const r = { out, bytes, ms: Date.now() - started, engine };
  progress({ message: `Done in ${(r.ms / 1000).toFixed(1)} s · ${fmtBytes(bytes)}`, done: true });
  return r;
}
const fmtBytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(1) + ' KB');

function runNative(cfg, file, opts, progress, signal) {
  const args = [];
  const env = { ...process.env };
  const tool = path.basename(file);
  let out = opts.out;
  if (tool === 'pg_dump') {
    args.push('-h', cfg.host || '127.0.0.1', '-p', String(cfg.port || 5432), '-U', cfg.user || 'postgres', '-d', opts.db || cfg.database || 'postgres', '--no-password', '-v');
    if (cfg.password) env.PGPASSWORD = cfg.password;
    if (cfg.ssl && cfg.ssl !== 'disable') env.PGSSLMODE = cfg.ssl === 'verify' ? 'verify-full' : 'require';
    if (opts.content === 'schema') args.push('--schema-only');
    if (opts.content === 'data') args.push('--data-only');
    if (opts.scope === 'schemas') for (const s of opts.schemas) args.push('-n', pgPattern(s));
    if (opts.scope === 'tables') for (const t of opts.tables) args.push('-t', `${pgPattern(t.schema)}.${pgPattern(t.table)}`);
    if (opts.noOwner) args.push('--no-owner', '--no-privileges');
    if (opts.dropIfExists && opts.content !== 'data' && opts.pgFormat !== 'custom') args.push('--clean', '--if-exists');
    if (opts.dataFormat === 'insert') args.push('--inserts', '--rows-per-insert=500');
    args.push('-F', opts.pgFormat === 'custom' ? 'c' : 'p', '-f', out);
    if (opts.gzip && opts.pgFormat !== 'custom') args.splice(args.indexOf('-f'), 0, '-Z', '6');
  } else if (tool === 'mysqldump' || tool === 'mariadb-dump') {
    args.push(`--host=${cfg.host || '127.0.0.1'}`, `--port=${cfg.port || 3306}`, `--user=${cfg.user || 'root'}`, '--protocol=TCP', '--single-transaction',
      '--default-character-set=utf8mb4', '--hex-blob', '--verbose', `--result-file=${out}`);
    if (cfg.password) env.MYSQL_PWD = cfg.password;
    if (opts.content === 'schema') args.push('--no-data');
    if (opts.content === 'data') args.push('--no-create-info', '--skip-triggers');
    else args.push('--routines', '--triggers');
    if (!opts.dropIfExists) args.push('--skip-add-drop-table');
    if (opts.scope === 'tables') {
      const schema = opts.tables[0]?.schema;
      if (opts.tables.some((t) => t.schema !== schema)) throw new Error('mysqldump can only dump tables from one database at a time.');
      args.push(schema, ...opts.tables.map((t) => t.table));
    } else args.push('--databases', ...(opts.schemas?.length ? opts.schemas : [cfg.database].filter(Boolean)));
  } else if (tool === 'mongodump') {
    const uri = new (require('./drivers/mongo.cjs').MongoDriver)(cfg).uri();
    args.push(`--uri=${uri}`, `--archive=${out}`);
    if (opts.gzip) args.push('--gzip');
    const dbName = opts.schemas?.[0] || opts.tables?.[0]?.schema;
    if (dbName) args.push(`--db=${dbName}`);
    if (opts.scope === 'tables') {
      if (opts.tables.length === 1) args.push(`--collection=${opts.tables[0].table}`);
      else {
        // mongodump takes one --collection, so exclude every other collection instead
        return listCollections(cfg, dbName).then((all) => {
          const keep = new Set(opts.tables.map((t) => t.table));
          for (const c of all) if (!keep.has(c)) args.push(`--excludeCollection=${c}`);
          return spawnTool(file, args, env, progress, signal);
        });
      }
    }
  }
  return spawnTool(file, args, env, progress, signal);
}
async function listCollections(cfg, dbName) {
  const d = new (require('./drivers/mongo.cjs').MongoDriver)(cfg);
  await d.connect();
  try { return (await d.objects(null, dbName)).map((o) => o.name); } finally { await d.close(); }
}
const pgPattern = (s) => '"' + String(s).replace(/"/g, '""') + '"';

function spawnTool(file, args, env, progress, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onLine = (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-4000);
      for (const line of s.split('\n')) if (line.trim()) progress({ message: line.replace(/^pg_dump: |^mysqldump: |^\d{4}-\d\d-\d\dT[\d:.+]+\s+/, '').trim() });
    };
    p.stdout.on('data', onLine);
    p.stderr.on('data', onLine);
    const abort = () => p.kill('SIGTERM');
    signal?.addEventListener('abort', abort);
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Dump cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(tail.trim().split('\n').slice(-3).join('\n') || `${path.basename(file)} exited with code ${code}`));
    });
  });
}

// ---------- built-in SQL dumper ----------
class Out {
  constructor(file, gzip) {
    this.file = fs.createWriteStream(file);
    this.stream = gzip ? zlib.createGzip({ level: 6 }) : this.file;
    if (gzip) this.stream.pipe(this.file);
    this.bytes = 0;
  }
  async write(s) {
    this.bytes += Buffer.byteLength(s);
    if (!this.stream.write(s)) await once(this.stream, 'drain');
  }
  async end() {
    const done = once(this.file, 'close');
    this.stream.end();
    await done;
  }
}

async function builtinSql(cfg, driver, opts, progress, signal) {
  const d = driver.dialect;
  const db = opts.db ?? null;
  const tables = await resolveTables(driver, db, opts);
  const out = new Out(opts.out, opts.gzip);
  const withSchema = opts.content !== 'data';
  const withData = opts.content !== 'schema';
  const now = new Date().toISOString();
  try {
    await out.write(`-- Pelican dump · ${cfg.name || cfg.type} · ${db || ''} · ${now}\n-- content: ${opts.content}, ${tables.length} table(s)\n\n`);
    if (d === 'pg') await out.write(`SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n\n`);
    if (d === 'mysql') await out.write(`SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\n\n`);
    if (d === 'sqlite') await out.write(`PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n\n`);

    const schemas = [...new Set(tables.map((t) => t.schema))];
    if (withSchema && d === 'pg') {
      for (const s of schemas) {
        if (s !== 'public') await out.write(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s, d)};\n`);
        for (const line of await driver.preamble(db, s)) await out.write(line + '\n');
      }
      await out.write('\n');
    }
    if (withSchema && d === 'mysql' && opts.scope !== 'tables') for (const s of schemas) await out.write(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(s, d)};\n`);

    // tables before views; views last because they depend on tables
    const ordered = [...tables.filter((t) => t.kind !== 'view'), ...tables.filter((t) => t.kind === 'view')];
    const fks = [];
    let done = 0;
    const total = ordered.length;
    for (const t of ordered) {
      if (signal?.aborted) throw new Error('Dump cancelled');
      const name = qualified(t.schema, t.table, d);
      if (withSchema) {
        progress({ table: `${t.schema}.${t.table}`, message: `Structure of ${t.schema}.${t.table}`, tablesDone: done, tablesTotal: total });
        await out.write(`--\n-- ${t.kind === 'view' ? 'View' : 'Table'}: ${t.schema}.${t.table}\n--\n`);
        if (opts.dropIfExists) await out.write(`DROP ${t.kind === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS ${name}${d === 'pg' ? ' CASCADE' : ''};\n`);
        let ddl = d === 'pg' ? await driver.ddl(db, t.schema, t.table, { foreignKeys: false }) : await driver.ddl(db, t.schema, t.table);
        if (d === 'mysql') ddl = ddl.replace(/^CREATE TABLE `/, `CREATE TABLE ${quoteIdent(t.schema, d)}.\``).replace(/^CREATE ALGORITHM=\S+ DEFINER=\S+ SQL SECURITY \w+ VIEW /, 'CREATE VIEW ');
        await out.write(ddl.trim() + '\n\n');
        if (t.kind !== 'view' && (d === 'pg' || d === 'db2')) fks.push(...(await driver.fkDdl(db, t.schema, t.table)));
      }
      if (withData && t.kind !== 'view') {
        const rows = await dumpRows(driver, d, db, t, out, opts, (n) => progress({ table: `${t.schema}.${t.table}`, rows: n, rowsTotal: t.rows, tablesDone: done, tablesTotal: total, bytes: out.bytes }), signal);
        progress({ message: `${t.schema}.${t.table}: ${rows.toLocaleString()} rows`, tablesDone: done + 1, tablesTotal: total, bytes: out.bytes });
      }
      done++;
    }
    if (withData && d === 'pg') for (const s of schemas) for (const line of await driver.sequenceValues(db, s)) await out.write(line + '\n');
    if (fks.length) await out.write('\n-- Foreign keys\n' + fks.join('\n') + '\n');
    if (d === 'mysql') await out.write(`\nSET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n`);
    if (d === 'sqlite') await out.write(`\nCOMMIT;\n`);
  } finally { await out.end(); }
}

async function resolveTables(driver, db, opts) {
  if (opts.scope === 'tables') {
    const out = [];
    const bySchema = new Map();
    for (const t of opts.tables) {
      if (!bySchema.has(t.schema)) bySchema.set(t.schema, await driver.objects(db, t.schema));
      const o = bySchema.get(t.schema).find((x) => x.name === t.table);
      out.push({ schema: t.schema, table: t.table, kind: o?.kind || 'table', rows: o?.rows });
    }
    return out;
  }
  const schemas = opts.scope === 'schemas' && opts.schemas?.length ? opts.schemas : await driver.schemas(db);
  const out = [];
  for (const s of schemas) for (const o of await driver.objects(db, s)) out.push({ schema: s, table: o.name, kind: o.kind, rows: o.rows });
  return out;
}

async function dumpRows(driver, d, db, t, out, opts, onRows, signal) {
  const name = qualified(t.schema, t.table, d);
  const cols = (await driver.columns(db, t.schema, t.table)).filter((c) => !(d === 'pg' && c.gen === 's'));
  const colList = cols.map((c) => quoteIdent(c.name, d)).join(', ');
  const sql = `SELECT ${colList} FROM ${name}`;
  const batch = d === 'db2' ? 100 : opts.batch || 500;
  let n = 0;
  let lastAt = 0;
  const copy = d === 'pg' && opts.dataFormat === 'copy';
  if (copy) await out.write(`COPY ${name} (${colList}) FROM stdin;\n`);
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    if (copy) await out.write(pending.join(''));
    else await out.write(`INSERT INTO ${name} (${colList}) VALUES\n${pending.join(',\n')};\n`);
    pending = [];
  };
  for await (const chunk of driver.stream(db, sql, 2000)) {
    if (signal?.aborted) throw new Error('Dump cancelled');
    for (const row of chunk.rows) {
      pending.push(copy ? row.map(copyText).join('\t') + '\n' : '(' + row.map((v) => literal(v, d)).join(', ') + ')');
      if (pending.length >= batch) await flush();
    }
    n += chunk.rows.length;
    if (Date.now() - lastAt > 150) { onRows(n); lastAt = Date.now(); }
  }
  await flush();
  if (copy) await out.write('\\.\n');
  await out.write('\n');
  onRows(n);
  return n;
}
function copyText(v) {
  if (v === null || v === undefined) return '\\N';
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// ---------- built-in MongoDB dumper: a mongosh script ----------
async function builtinMongo(driver, opts, progress, signal) {
  const dbName = opts.schemas?.[0] || opts.tables?.[0]?.schema || driver.defaultDb();
  const colls = opts.scope === 'tables' ? opts.tables.map((t) => ({ name: t.table })) : (await driver.objects(null, dbName)).filter((o) => o.kind !== 'view');
  const out = new Out(opts.out, opts.gzip);
  try {
    await out.write(`// Pelican dump · ${dbName} · ${new Date().toISOString()}\n// Restore: mongosh "mongodb://host/${dbName}" this-file.js\n\n`);
    let done = 0;
    for (const c of colls) {
      if (signal?.aborted) throw new Error('Dump cancelled');
      const coll = driver.client.db(dbName).collection(c.name);
      const ref = `db.getCollection(${JSON.stringify(c.name)})`;
      if (opts.content !== 'data') {
        if (opts.dropIfExists) await out.write(`${ref}.drop();\n`);
        await out.write(`db.createCollection(${JSON.stringify(c.name)});\n`);
        for (const ix of await coll.indexes()) if (ix.name !== '_id_') {
          const { key, v, ns, ...o } = ix;
          await out.write(`${ref}.createIndex(${shell(key)}, ${shell(o)});\n`);
        }
      }
      if (opts.content !== 'schema') {
        let n = 0;
        let buf = [];
        for await (const doc of coll.find({}, { batchSize: 1000 })) {
          buf.push(shell(doc));
          if (buf.length >= 500) { await out.write(`${ref}.insertMany([\n${buf.join(',\n')}\n]);\n`); n += buf.length; buf = []; progress({ table: `${dbName}.${c.name}`, rows: n, tablesDone: done, tablesTotal: colls.length, bytes: out.bytes }); if (signal?.aborted) throw new Error('Dump cancelled'); }
        }
        if (buf.length) { await out.write(`${ref}.insertMany([\n${buf.join(',\n')}\n]);\n`); n += buf.length; }
        progress({ message: `${dbName}.${c.name}: ${n.toLocaleString()} documents`, tablesDone: done + 1, tablesTotal: colls.length, bytes: out.bytes });
      }
      await out.write('\n');
      done++;
    }
  } finally { await out.end(); }
}
/** A value as mongosh source (keeps ObjectId, dates, longs and decimals). */
function shell(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return `ISODate(${JSON.stringify(v.toISOString())})`;
  if (v instanceof RegExp) return v.toString();
  if (Array.isArray(v)) return '[' + v.map(shell).join(', ') + ']';
  if (typeof v === 'object') {
    switch (v._bsontype) {
      case 'ObjectId': case 'ObjectID': return `ObjectId(${JSON.stringify(v.toHexString())})`;
      case 'Long': return `NumberLong(${JSON.stringify(v.toString())})`;
      case 'Decimal128': return `NumberDecimal(${JSON.stringify(v.toString())})`;
      case 'Int32': return `NumberInt(${v.value})`;
      case 'Double': return String(v.value);
      case 'Binary': return `BinData(${v.sub_type}, ${JSON.stringify(Buffer.from(v.buffer).toString('base64'))})`;
      case 'Timestamp': return `Timestamp({ t: ${v.high}, i: ${v.low} })`;
      case 'UUID': return `UUID(${JSON.stringify(v.toHexString())})`;
      default: break;
    }
    return '{' + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${shell(x)}`).join(', ') + '}';
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN';
  return JSON.stringify(v);
}

module.exports = { runDump, toolsStatus, nativeTool, findTools, shell };
