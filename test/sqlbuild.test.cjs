'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSelect, buildDistinct, buildCount, wrapQuery } = require('../electron/drivers/sqlbuild.cjs');

test('table select with filter box, column filters, sort and paging', () => {
  const q = buildSelect({ dialect: 'pg', schema: 'shop', table: 'orders', where: 'total > 100', filters: [{ col: 'status', op: 'in', values: ['paid', null] }, { col: 'note', op: 'contains', values: ['door'] }], order: [{ col: 'total', dir: 'desc' }], limit: 50, offset: 100 });
  assert.strictEqual(q.sql, `SELECT * FROM "shop"."orders" WHERE (total > 100) AND ("status"::text IN ($1) OR "status" IS NULL) AND "note"::text ILIKE $2 ORDER BY "total" DESC LIMIT 50 OFFSET 100`);
  assert.deepStrictEqual(q.params, ['paid', '%door%']);
});

test('not-in keeps NULL rows unless NULL is excluded too', () => {
  assert.match(buildSelect({ dialect: 'mysql', schema: 's', table: 't', filters: [{ col: 'a', op: 'nin', values: ['x'] }] }).sql, /\(NOT `a` IN \(\?\) OR `a` IS NULL\)/);
  assert.match(buildSelect({ dialect: 'mysql', schema: 's', table: 't', filters: [{ col: 'a', op: 'nin', values: ['x', null] }] }).sql, /NOT `a` IN \(\?\)/);
  assert.match(buildSelect({ dialect: 'mysql', schema: 's', table: 't', filters: [{ col: 'a', op: 'nin', values: [null] }] }).sql, /`a` IS NOT NULL/);
});

test('db2 paging and sqlite main schema', () => {
  assert.match(buildSelect({ dialect: 'db2', schema: 'S', table: 'T', limit: 10, offset: 20 }).sql, /OFFSET 20 ROWS FETCH FIRST 10 ROWS ONLY$/);
  assert.strictEqual(buildSelect({ dialect: 'sqlite', schema: 'main', table: 't', limit: 5 }).sql, 'SELECT * FROM "t" LIMIT 5');
});

test('distinct ignores the column\'s own filter; count and wrap', () => {
  const d = buildDistinct({ dialect: 'pg', schema: 's', table: 't', col: 'a', filters: [{ col: 'a', op: 'eq', values: [1] }, { col: 'b', op: 'eq', values: [2] }] });
  assert.match(d.sql, /WHERE "b" = \$1 GROUP BY "a"/);
  assert.strictEqual(buildCount({ dialect: 'pg', schema: 's', table: 't' }).sql, 'SELECT COUNT(*) AS n FROM "s"."t"');
  assert.strictEqual(wrapQuery({ dialect: 'mysql', sql: 'select * from t;', where: 'x = 1', limit: 10 }).sql, 'SELECT * FROM (select * from t) `q` WHERE (x = 1) LIMIT 10');
});
