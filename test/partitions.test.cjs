'use strict';
// Needs a throwaway PostgreSQL: PELICAN_TEST_PG=postgres://user@127.0.0.1:5433/postgres npm test
// It creates and drops the schema pelican_parts_test there. Skipped when the variable is not set.
const test = require('node:test');
const assert = require('node:assert');
const { PgDriver } = require('../electron/drivers/pg.cjs');
const { McpServer } = require('../electron/mcp.cjs');

const url = process.env.PELICAN_TEST_PG;
const S = 'pelican_parts_test';

test('PostgreSQL partitioned tables', { skip: !url && 'set PELICAN_TEST_PG to a throwaway server' }, async (t) => {
  const u = new URL(url);
  const d = new PgDriver({ host: u.hostname, port: +u.port || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) || 'postgres' });
  await d.connect();
  const q = (sql) => d.q(null, sql);
  await q(`drop schema if exists ${S} cascade; create schema ${S}`);
  await q(`create table ${S}.ev (id int, at date not null, kind text not null) partition by range (at)`);
  await q(`create table ${S}.ev_2026_01 partition of ${S}.ev for values from ('2026-01-01') to ('2026-02-01')`);
  await q(`create table ${S}.ev_2026_02 partition of ${S}.ev for values from ('2026-02-01') to ('2026-03-01') partition by list (kind)`);
  await q(`create table ${S}.ev_2026_02_a partition of ${S}.ev_2026_02 for values in ('a')`);
  await q(`create table ${S}.ev_2026_02_rest partition of ${S}.ev_2026_02 default`);
  await q(`create table ${S}.ev_other partition of ${S}.ev default`);
  await q(`insert into ${S}.ev select g, date '2026-01-01' + g % 59, case when g % 2 = 0 then 'a' else 'b' end from generate_series(1, 200) g`);
  await q(`analyze ${S}.ev`);
  try {
    await t.test('only the partitioned table is listed, with its key and summed rows', async () => {
      const objs = await d.objects(null, S);
      assert.deepStrictEqual(objs.map((o) => o.name), ['ev']);
      assert.strictEqual(objs[0].partitionKey, 'RANGE (at)');
      assert.strictEqual(objs[0].partitions, 3);
      assert.strictEqual(objs[0].rows, 200);
    });
    await t.test('partitions come with bounds, levels and the root', async () => {
      const p = await d.partitions(null, S, 'ev');
      assert.deepStrictEqual(p.partitions.map((x) => [x.level, x.name, x.parent]), [[1, 'ev_2026_01', 'ev'], [1, 'ev_2026_02', 'ev'], [2, 'ev_2026_02_a', 'ev_2026_02'], [2, 'ev_2026_02_rest', 'ev_2026_02'], [1, 'ev_other', 'ev']]);
      assert.strictEqual(p.partitions[1].key, 'LIST (kind)');
      assert.strictEqual(p.partitions[1].rows, p.partitions[2].rows + p.partitions[3].rows);
      const leaf = await d.partitions(null, S, 'ev_2026_02_a');
      assert.deepStrictEqual(leaf.root, { schema: S, table: 'ev' });
      assert.strictEqual(leaf.partitionOf.bound, "FOR VALUES IN ('a')");
      assert.strictEqual(await d.partitions(null, 'pg_catalog', 'pg_class'), null);
    });
    await t.test('a plan that scans partitions reports the partitioned table', async () => {
      const r = await d.planTables(null, `select * from ${S}.ev where at >= '2026-02-10' and kind = 'a'`);
      assert.deepStrictEqual(r, [{ schema: S, table: 'ev', partition: 'ev_2026_02_a' }]);
      assert.deepStrictEqual((await d.planTables(null, `select count(*) from ${S}.ev`)).map((x) => x.table), ['ev']);
    });
    await t.test('the DDL recreates the partitions', async () => {
      const ddl = await d.ddl(null, S, 'ev');
      assert.match(ddl, /\) PARTITION BY RANGE \(at\);/);
      assert.match(ddl, /CREATE TABLE "pelican_parts_test"\."ev_2026_02_a" PARTITION OF "pelican_parts_test"\."ev_2026_02" FOR VALUES IN \('a'\);/);
      assert.match(await d.ddl(null, S, 'ev_2026_01'), /PARTITION OF "pelican_parts_test"\."ev"\n {2}FOR VALUES FROM/);
    });
    await t.test('MCP scope on the partitioned table covers its partitions', async () => {
      const conn = { id: 'c', name: 'test', type: 'postgres', database: d.cfg.database };
      const srv = new McpServer({ config: () => ({ mcp: { policies: { c: { access: 'read', scope: 'custom', allow: { [`|${S}`]: ['ev'] } } } }, connections: [conn] }), open: async () => ({ driver: d }), log() {}, activity() {}, confirm: async () => false });
      const call = (name, a) => srv.call(name, { connection: 'test', ...a });
      const ok = await call('query', { sql: `select count(*) from ${S}.ev where at < '2026-01-15'` });
      assert.ok(!ok.isError, ok.content[0].text);
      assert.ok(!(await call('query', { sql: `select count(*) from ${S}.ev_2026_02_rest` })).isError);
      const desc = JSON.parse((await call('describe_table', { schema: S, table: 'ev' })).content[0].text);
      assert.strictEqual(desc.partitioning.partition_by, 'RANGE (at)');
      assert.strictEqual(desc.partitioning.partitions.length, 5);
      assert.ok((await call('query', { sql: 'select count(*) from pg_catalog.pg_class' })).isError);
    });
  } finally {
    await q(`drop schema ${S} cascade`);
    await d.close();
  }
});
