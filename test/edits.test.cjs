'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildEdits, editsText } = require('../electron/drivers/sqlbuild.cjs');

const changes = [
  { op: 'update', key: [{ col: 'id', v: 5 }], set: [{ col: 'name', v: "O'Hara" }, { col: 'note', v: null }] },
  { op: 'delete', key: [{ col: 'a', v: 'x' }, { col: 'b', v: null }] },
  { op: 'insert', values: [{ col: 'name', v: 'z' }] },
];

test('edits become parameterised statements that must touch one row', () => {
  const st = buildEdits({ dialect: 'pg', schema: 'shop', table: 'customers', changes });
  assert.deepStrictEqual(st.map((s) => s.sql), [
    'UPDATE "shop"."customers" SET "name" = $1, "note" = NULL WHERE "id" = $2',
    'DELETE FROM "shop"."customers" WHERE "a" = $1 AND "b" IS NULL',
    'INSERT INTO "shop"."customers" ("name") VALUES ($1)',
  ]);
  assert.deepStrictEqual(st.map((s) => s.params), [["O'Hara", 5], ['x'], ['z']]);
  assert.ok(st.every((s) => s.expect === 1));
});

test('MySQL and Db2 placeholders and empty inserts', () => {
  const my = buildEdits({ dialect: 'mysql', schema: 'shop', table: 't', changes: [...changes, { op: 'insert', values: [] }] });
  assert.strictEqual(my[0].sql, 'UPDATE `shop`.`t` SET `name` = ?, `note` = NULL WHERE `id` = ?');
  assert.strictEqual(my[3].sql, 'INSERT INTO `shop`.`t` () VALUES ()');
  const db2 = buildEdits({ dialect: 'db2', schema: 'SHOP', table: 'T', changes: [{ op: 'insert', values: [], firstCol: 'ID' }] });
  assert.strictEqual(db2[0].sql, 'INSERT INTO "SHOP"."T" ("ID") VALUES (DEFAULT)');
  const lite = buildEdits({ dialect: 'sqlite', schema: 'main', table: 't', changes: [{ op: 'insert', values: [] }] });
  assert.strictEqual(lite[0].sql, 'INSERT INTO "t" DEFAULT VALUES');
});

test('a change without a key is refused', () => {
  assert.throws(() => buildEdits({ dialect: 'pg', schema: 's', table: 't', changes: [{ op: 'delete', key: [] }] }), /no key/);
});

test('preview writes the values in', () => {
  assert.strictEqual(editsText({ dialect: 'pg', schema: 'shop', table: 'customers', changes: changes.slice(0, 1) }),
    `UPDATE "shop"."customers" SET "name" = 'O''Hara', "note" = NULL WHERE "id" = 5;`);
});
