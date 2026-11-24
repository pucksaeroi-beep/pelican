'use strict';
// Built-in dumper round trip on SQLite: dump → restore into a fresh file → same rows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { SqliteDriver } = require('../electron/drivers/sqlite.cjs');
const { runDump, shell } = require('../electron/dump.cjs');

process.removeAllListeners('warning');

test('sqlite dump round trip, all / schema-only / data-only / picked tables / gzip', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-dump-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src.db');
  const db = new DatabaseSync(src);
  db.exec(`create table a (id integer primary key, name text, data blob, price real);
    create table b (id integer primary key, a_id integer references a(id), note text);
    create index b_a on b(a_id);
    create view v as select a.name, b.note from a join b on b.a_id = a.id;`);
  const ins = db.prepare('insert into a (name, data, price) values (?, ?, ?)');
  for (let i = 0; i < 2500; i++) ins.run(`name ${i} 'quoted' ; ข้อความ`, Buffer.from([i % 256, 0, 255]), i / 3);
  db.exec("insert into b (a_id, note) values (1, 'x'), (2, NULL)");
  db.close();

  const driver = new SqliteDriver({ type: 'sqlite', file: src });
  await driver.connect();
  t.after(() => driver.close());
  const cfg = { type: 'sqlite', name: 't' };
  const dump = (o) => runDump({ cfg, driver }, { scope: 'database', schemas: ['main'], content: 'all', engine: 'auto', ...o }, () => {});

  const full = path.join(dir, 'full.sql');
  await dump({ out: full });
  const r = new DatabaseSync(path.join(dir, 'r1.db'));
  r.exec(fs.readFileSync(full, 'utf8'));
  assert.strictEqual(r.prepare('select count(*) n from a').get().n, 2500);
  assert.strictEqual(r.prepare("select name from a where id = 7").get().name, "name 6 'quoted' ; ข้อความ");
  assert.deepStrictEqual([...r.prepare('select data from a where id = 2').get().data], [1, 0, 255]);
  assert.strictEqual(r.prepare('select count(*) n from v').get().n, 2);
  r.close();

  const schemaOnly = path.join(dir, 'schema.sql');
  await dump({ out: schemaOnly, content: 'schema' });
  const s = fs.readFileSync(schemaOnly, 'utf8');
  assert.match(s, /CREATE TABLE a \(/);
  assert.match(s, /CREATE INDEX b_a/);
  assert.doesNotMatch(s, /INSERT INTO/);

  const dataOnly = path.join(dir, 'data.sql');
  await dump({ out: dataOnly, content: 'data', scope: 'tables', tables: [{ schema: 'main', table: 'b' }] });
  const d = fs.readFileSync(dataOnly, 'utf8');
  assert.doesNotMatch(d, /CREATE TABLE/);
  assert.match(d, /INSERT INTO "b"/);
  assert.doesNotMatch(d, /INSERT INTO "a"/);

  const gz = path.join(dir, 'full.sql.gz');
  await dump({ out: gz, gzip: true });
  assert.match(zlib.gunzipSync(fs.readFileSync(gz)).toString(), /INSERT INTO "a"/);
});

test('mongosh literal writer keeps BSON types', () => {
  const { ObjectId, Long, Decimal128 } = require('mongodb');
  const out = shell({ _id: new ObjectId('64b7f0a2c2a4b1d2e3f40516'), at: new Date('2025-01-02T03:04:05Z'), n: Long.fromString('9007199254740993'), d: Decimal128.fromString('1.10'), tags: ['a', null] });
  assert.strictEqual(out, '{"_id": ObjectId("64b7f0a2c2a4b1d2e3f40516"), "at": ISODate("2025-01-02T03:04:05.000Z"), "n": NumberLong("9007199254740993"), "d": NumberDecimal("1.10"), "tags": ["a", null]}');
});
