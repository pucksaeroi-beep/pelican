'use strict';
// The MCP server against a throwaway SQLite database: tokens, read-only, scope and write confirmation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpServer, allowed } = require('../electron/mcp.cjs');
const { SqliteDriver } = require('../electron/drivers/sqlite.cjs');

process.removeAllListeners('warning');

test('policy scope rules', () => {
  const p = { access: 'read', scope: 'custom', allow: { 'app|public': ['users'], '|shop': '*' } };
  assert.ok(allowed(p, 'app', 'public', 'users'));
  assert.ok(!allowed(p, 'app', 'public', 'secrets'));
  assert.ok(!allowed(p, 'other', 'public', 'users'));
  assert.ok(allowed(p, null, 'shop', 'anything'));
  assert.ok(!allowed({ access: 'off' }, null, 'shop', 'x'));
  assert.ok(allowed({ access: 'read', scope: 'all' }, null, 'x', 'y'));
  assert.ok(allowed({ access: 'read', scope: 'custom', allow: { '|Shop': ['Orders'] } }, null, 'shop', 'orders', true));
});

test('MCP over HTTP', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-mcp-'));
  const file = path.join(dir, 't.db');
  const driver = new SqliteDriver({ type: 'sqlite', file });
  await driver.connect();
  await driver.query(null, 'create table users (id integer primary key, name text)');
  await driver.query(null, 'create table secrets (id integer primary key, value text)');
  await driver.query(null, "insert into users (name) values ('ann'), ('bob'), ('cy')");
  await driver.query(null, "insert into secrets (value) values ('hunter2')");
  const conns = [{ id: 'c1', name: 'local', type: 'sqlite', file }];
  const mcp = { enabled: true, port: 7439, token: 'tok', requireToken: true, policies: { c1: { access: 'read', scope: 'custom', allow: { '|main': ['users'] }, maxRows: 2 } } };
  let confirmed = null;
  const server = new McpServer({
    config: () => ({ mcp, connections: conns }), open: async () => ({ driver, cfg: conns[0] }),
    log: () => {}, activity: () => {}, confirm: async (x) => { confirmed = x; return true; },
  });
  await server.start();
  t.after(async () => { await server.stop(); await driver.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const rpc = async (method, params, token = 'tok', extra = {}) => {
    const r = await fetch('http://127.0.0.1:7439/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  };
  const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return r.body.result; };

  assert.strictEqual((await rpc('initialize', {}, null)).status, 401);
  assert.strictEqual((await rpc('initialize', {}, 'wrong')).status, 401);
  assert.strictEqual((await rpc('initialize', {}, 'tok', { Origin: 'https://evil.example' })).status, 403);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.strictEqual(init.body.result.serverInfo.name, 'pelican');
  const names = (await rpc('tools/list')).body.result.tools.map((x) => x.name);
  assert.ok(names.includes('query') && !names.includes('execute'), 'no execute tool while every connection is read-only');

  const tables = JSON.parse((await tool('list_tables', { connection: 'local' })).content[0].text);
  assert.deepStrictEqual(tables.schemas.main.map((x) => x.name), ['users']);

  const ok = await tool('query', { connection: 'local', sql: 'select name from users order by id' });
  const data = JSON.parse(ok.content[0].text);
  assert.deepStrictEqual(data.rows, [['ann'], ['bob']]);
  assert.strictEqual(data.truncated, true, 'capped by the policy max rows');

  for (const sql of ['select * from secrets', 'select u.name from users u join secrets s on s.id = u.id', 'select (select value from secrets) from users']) {
    const r = await tool('query', { connection: 'local', sql });
    assert.ok(r.isError && /secrets/.test(r.content[0].text), `blocked: ${sql}`);
  }
  const w = await tool('query', { connection: 'local', sql: "update users set name = 'x'" });
  assert.ok(w.isError);
  const desc = await tool('describe_table', { connection: 'local', schema: 'main', table: 'secrets' });
  assert.ok(desc.isError);

  // now allow writes with confirmation
  mcp.policies.c1 = { access: 'write', scope: 'all', confirmWrites: true };
  const ex = await tool('execute', { connection: 'local', sql: "update users set name = 'zed' where id = 3" });
  assert.ok(!ex.isError, ex.content[0].text);
  assert.strictEqual(JSON.parse(ex.content[0].text).affected_rows, 1);
  assert.match(confirmed.sql, /update users/);
  const unknown = await tool('query', { connection: 'nope', sql: 'select 1' });
  assert.ok(unknown.isError);
});
