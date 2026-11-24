'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { splitStatements, statementAt, readOnlyProblem, statementKind, literal, quoteIdent } = require('../electron/lib/sqltext.cjs');

test('splits on top-level semicolons only', () => {
  const sql = `select 'a;b' as x; -- c;d
select "we;ird" from t; /* x; y */ select $$ ; $$; select $tag$ a;b $tag$`;
  assert.deepStrictEqual(splitStatements(sql, 'pg').map((s) => s.sql), [`select 'a;b' as x`, `-- c;d\nselect "we;ird" from t`, `/* x; y */ select $$ ; $$`, `select $tag$ a;b $tag$`]);
});

test('keeps trigger bodies together', () => {
  const sql = `create trigger t after insert on a begin insert into b values (1); update c set x = 1; end; select 1`;
  assert.strictEqual(splitStatements(sql, 'sqlite').length, 2);
});

test('mysql backticks and backslash escapes', () => {
  const sql = "select `a;b` from t where x = 'it\\'s;'; select 2";
  assert.strictEqual(splitStatements(sql, 'mysql').length, 2);
});

test('statementAt finds the statement under the cursor', () => {
  const text = 'select 1;\n\nselect 2;\nselect 3';
  assert.strictEqual(statementAt(text, text.indexOf('2'), 'pg').sql, 'select 2');
  assert.strictEqual(statementAt(text, text.length, 'pg').sql, 'select 3');
});

test('read-only check', () => {
  assert.strictEqual(readOnlyProblem('select * from t', 'pg'), null);
  assert.strictEqual(readOnlyProblem('with x as (select 1) select * from x', 'pg'), null);
  assert.strictEqual(readOnlyProblem("select 'delete from t' as s, \"update\" from t", 'pg'), null);
  assert.ok(readOnlyProblem('delete from t', 'pg'));
  assert.ok(readOnlyProblem('with x as (delete from t returning *) select * from x', 'pg'));
  assert.ok(readOnlyProblem('select 1; select 2', 'pg'));
  assert.ok(readOnlyProblem("select * into outfile '/tmp/x' from t", 'mysql'));
  assert.ok(readOnlyProblem("select set_config('a', 'b', false)", 'pg'));
  assert.ok(readOnlyProblem('explain analyze delete from t', 'pg'));
  assert.ok(readOnlyProblem('pragma writable_schema = 1', 'sqlite'));
  assert.strictEqual(readOnlyProblem("pragma table_info('t')", 'sqlite'), null);
  assert.strictEqual(statementKind('  -- hi\nSELECT 1', 'pg'), 'read');
  assert.strictEqual(statementKind('insert into t values (1)', 'pg'), 'write');
});

test('literals and identifiers', () => {
  assert.strictEqual(literal("it's", 'pg'), "'it''s'");
  assert.strictEqual(literal('a\\b', 'mysql'), "'a\\\\b'");
  assert.strictEqual(literal(Buffer.from([1, 255]), 'pg'), "'\\x01ff'");
  assert.strictEqual(literal(Buffer.from([1, 255]), 'mysql'), "X'01ff'");
  assert.strictEqual(literal(null, 'pg'), 'NULL');
  assert.strictEqual(literal(true, 'mysql'), '1');
  assert.strictEqual(quoteIdent('we"ird', 'pg'), '"we""ird"');
  assert.strictEqual(quoteIdent('a`b', 'mysql'), '`a``b`');
});

test('the editor copy of the splitter matches the main one', () => {
  const src = fs.readFileSync(path.join(__dirname, '../electron/lib/sqltext.cjs'), 'utf8');
  const copy = fs.readFileSync(path.join(__dirname, '../src/lib/sqlsplit.js'), 'utf8');
  const body = (s) => s.slice(s.indexOf('/** Walk the text'), s.indexOf('/** Lower-case words') > 0 ? s.indexOf('/** Lower-case words') : undefined).replace(/export /g, '').trim();
  assert.strictEqual(body(copy), body(src));
});
