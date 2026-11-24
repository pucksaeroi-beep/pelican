'use strict';
// Fill a database with the made-up demo shop. Usage:
//   node scripts/seed-demo.cjs sqlite ./demo/shop.db
//   node scripts/seed-demo.cjs postgres postgres://postgres@127.0.0.1:5432/postgres
//   node scripts/seed-demo.cjs mysql mysql://root:pw@127.0.0.1:3306/shop
//   node scripts/seed-demo.cjs mongo mongodb://127.0.0.1:27017/shop
//   node scripts/seed-demo.cjs db2 "DATABASE=testdb;HOSTNAME=127.0.0.1;PORT=50000;PROTOCOL=TCPIP;UID=db2inst1;PWD=..."
// It creates a schema/database called "shop" (drops it first) and never touches anything else.
const { build } = require('./demo-data.cjs');
const { literal, quoteIdent: qi } = require('../electron/lib/sqltext.cjs');

// Db2 folds unquoted names to upper case, so its demo uses upper-case names like a real Db2 schema
const quoteIdent = (n, d) => qi(d === 'db2' ? String(n).toUpperCase() : n, d);

const data = build();
const [, , type, target] = process.argv;

const TABLES = {
  categories: [['id', 'INT', 'pk'], ['name', 'VARCHAR(60)', 'nn'], ['description', 'VARCHAR(200)']],
  products: [['id', 'INT', 'pk'], ['sku', 'VARCHAR(20)', 'nn'], ['name', 'VARCHAR(120)', 'nn'], ['category_id', 'INT', 'fk:categories'], ['price', 'DECIMAL(10,2)', 'nn'], ['stock', 'INT', 'nn'], ['active', 'BOOL', 'nn'], ['created_at', 'TIMESTAMP', 'nn']],
  customers: [['id', 'INT', 'pk'], ['name', 'VARCHAR(120)', 'nn'], ['email', 'VARCHAR(160)', 'nn'], ['city', 'VARCHAR(60)'], ['tier', 'VARCHAR(10)', 'nn'], ['phone', 'VARCHAR(20)'], ['created_at', 'TIMESTAMP', 'nn']],
  orders: [['id', 'INT', 'pk'], ['customer_id', 'INT', 'fk:customers'], ['status', 'VARCHAR(12)', 'nn'], ['total', 'DECIMAL(12,2)', 'nn'], ['note', 'VARCHAR(200)'], ['ordered_at', 'TIMESTAMP', 'nn']],
  order_items: [['id', 'INT', 'pk'], ['order_id', 'INT', 'fk:orders'], ['product_id', 'INT', 'fk:products'], ['quantity', 'INT', 'nn'], ['unit_price', 'DECIMAL(10,2)', 'nn']],
};

function ddl(d, schema) {
  const out = [];
  const name = (t) => (schema ? `${quoteIdent(schema, d)}.${quoteIdent(t, d)}` : quoteIdent(t, d));
  for (const [t, cols] of Object.entries(TABLES)) {
    const lines = cols.map(([c, type, flag]) => {
      let ty = type;
      if (type === 'BOOL') ty = d === 'pg' ? 'BOOLEAN' : d === 'db2' ? 'SMALLINT' : 'TINYINT(1)';
      if (type === 'TIMESTAMP' && d === 'mysql') ty = 'DATETIME';
      if (d === 'db2' && type.startsWith('VARCHAR')) ty = type.replace(/\((\d+)\)/, (m, n) => `(${n * 3})`); // utf-8 bytes
      return `  ${quoteIdent(c, d)} ${ty}${flag === 'pk' ? ' NOT NULL PRIMARY KEY' : flag === 'nn' || flag?.startsWith('fk') ? ' NOT NULL' : ''}`;
    });
    // table-level foreign keys: MySQL ignores the inline column form
    for (const [c, , flag] of cols) if (flag?.startsWith('fk')) lines.push(`  FOREIGN KEY (${quoteIdent(c, d)}) REFERENCES ${name(flag.slice(3))}(${quoteIdent('id', d)})`);
    out.push(`CREATE TABLE ${name(t)} (\n${lines.join(',\n')}\n)`);
  }
  out.push(`CREATE INDEX ${schema && d === 'db2' ? quoteIdent(schema, d) + '.' : ''}${quoteIdent('orders_customer_idx', d)} ON ${name('orders')} (${quoteIdent('customer_id', d)})`);
  out.push(`CREATE INDEX ${schema && d === 'db2' ? quoteIdent(schema, d) + '.' : ''}${quoteIdent('order_items_order_idx', d)} ON ${name('order_items')} (${quoteIdent('order_id', d)})`);
  out.push(`CREATE VIEW ${name('order_summary')} AS SELECT o.${quoteIdent('id', d)} AS order_id, c.${quoteIdent('name', d)} AS customer, o.${quoteIdent('status', d)}, o.${quoteIdent('total', d)}, o.${quoteIdent('ordered_at', d)} FROM ${name('orders')} o JOIN ${name('customers')} c ON c.${quoteIdent('id', d)} = o.${quoteIdent('customer_id', d)}`);
  return out;
}
function inserts(d, schema, batch = 200) {
  const out = [];
  for (const t of Object.keys(TABLES)) {
    const cols = TABLES[t].map(([c]) => c);
    const rows = data[t];
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch).map((r) => '(' + cols.map((c) => (d === 'db2' && typeof r[c] === 'boolean' ? (r[c] ? 1 : 0) : literal(r[c], d))).join(', ') + ')');
      out.push(`INSERT INTO ${schema ? quoteIdent(schema, d) + '.' : ''}${quoteIdent(t, d)} (${cols.map((c) => quoteIdent(c, d)).join(', ')}) VALUES\n${chunk.join(',\n')}`);
    }
  }
  return out;
}

async function main() {
  if (type === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    require('fs').rmSync(target, { force: true });
    const db = new DatabaseSync(target);
    db.exec('PRAGMA foreign_keys = ON; BEGIN');
    for (const s of [...ddl('sqlite'), ...inserts('sqlite')]) db.exec(s);
    db.exec('COMMIT');
    db.close();
  } else if (type === 'postgres') {
    const { Client } = require('pg');
    const c = new Client({ connectionString: target });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS shop CASCADE; CREATE SCHEMA shop');
    for (const s of [...ddl('pg', 'shop'), ...inserts('pg', 'shop')]) await c.query(s);
    await c.query(`COMMENT ON TABLE shop.orders IS 'One row per checkout'; ANALYZE`);
    await c.end();
  } else if (type === 'mysql') {
    const mysql = require('mysql2/promise');
    const u = new URL(target.replace(/^mysql:/, 'http:'));
    const c = await mysql.createConnection({ host: u.hostname, port: +u.port || 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), charset: 'utf8mb4' });
    await c.query('DROP DATABASE IF EXISTS shop');
    await c.query('CREATE DATABASE shop CHARACTER SET utf8mb4');
    for (const s of [...ddl('mysql', 'shop'), ...inserts('mysql', 'shop')]) await c.query(s);
    await c.query('ANALYZE TABLE shop.orders, shop.customers, shop.products, shop.order_items');
    await c.end();
  } else if (type === 'mongo') {
    const { MongoClient } = require('mongodb');
    const c = new MongoClient(target);
    await c.connect();
    const db = c.db('shop');
    await db.dropDatabase();
    const fix = (r) => ({ ...r, _id: r.id, id: undefined, created_at: r.created_at && new Date(r.created_at + 'Z'), ordered_at: r.ordered_at && new Date(r.ordered_at + 'Z') });
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    for (const t of ['categories', 'products', 'customers']) await db.collection(t).insertMany(data[t].map((r) => clean(fix(r))));
    const byOrder = new Map();
    for (const it of data.order_items) { if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []); byOrder.get(it.order_id).push({ product_id: it.product_id, quantity: it.quantity, unit_price: it.unit_price }); }
    await db.collection('orders').insertMany(data.orders.map((o) => clean({ ...fix(o), items: byOrder.get(o.id) || [] })));
    await db.collection('orders').createIndex({ customer_id: 1 });
    await db.collection('customers').createIndex({ email: 1 }, { unique: true });
    await c.close();
  } else if (type === 'db2') {
    const ibm = require('ibm_db');
    const c = await ibm.open(target);
    for (const v of ['ORDER_SUMMARY', 'order_summary']) { try { await c.query(`DROP VIEW "SHOP"."${v}"`); } catch { /* none */ } }
    for (const t of ['order_items', 'orders', 'customers', 'products', 'categories']) for (const n of [t, t.toUpperCase()]) { try { await c.query(`DROP TABLE "SHOP"."${n}"`); } catch { /* none */ } }
    for (const s of [...ddl('db2', 'SHOP'), ...inserts('db2', 'SHOP', 100)]) await c.query(s);
    await c.close();
  } else {
    console.error('usage: node scripts/seed-demo.cjs <sqlite|postgres|mysql|mongo|db2> <target>');
    process.exit(1);
  }
  console.log(`seeded ${type}: ${Object.entries(data).map(([k, v]) => `${k}=${v.length}`).join(' ')}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
