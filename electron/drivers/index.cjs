'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TYPES = {
  postgres: { label: 'PostgreSQL', port: 5432, user: 'postgres', database: 'postgres', make: (c) => new (require('./pg.cjs').PgDriver)(c) },
  mysql: { label: 'MySQL / MariaDB', port: 3306, user: 'root', database: '', make: (c) => new (require('./mysql.cjs').MysqlDriver)(c) },
  sqlite: { label: 'SQLite', make: (c) => new (require('./sqlite.cjs').SqliteDriver)(c) },
  mongo: { label: 'MongoDB', port: 27017, user: '', database: '', make: (c) => new (require('./mongo.cjs').MongoDriver)(c) },
  db2: { label: 'IBM Db2', port: 50000, user: 'db2inst1', database: 'SAMPLE', make: (c) => new (require('./db2.cjs').Db2Driver)(c) },
};

function makeDriver(cfg) {
  const t = TYPES[cfg.type];
  if (!t) throw new Error(`Unknown database type: ${cfg.type}`);
  return t.make(cfg);
}

/** Try a TCP connect; resolves true if something listens. */
function probe(port, host = '127.0.0.1', ms = 350) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Database servers running on this Mac, plus SQLite files in the usual places. */
async function detectLocal() {
  const ports = [
    ['postgres', 5432], ['postgres', 5433], ['postgres', 5434], ['mysql', 3306], ['mysql', 3307], ['mysql', 3308],
    ['mongo', 27017], ['mongo', 27018], ['db2', 50000], ['db2', 50001],
  ];
  const found = [];
  await Promise.all(ports.map(async ([type, port]) => { if (await probe(port)) found.push({ type, host: 'localhost', port }); }));
  found.sort((a, b) => a.type.localeCompare(b.type) || a.port - b.port);
  return found;
}

/** Parse a connection URL into connection fields (postgres://, mysql://, mongodb://, db2://, file path). */
function parseUrl(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^(\/|~\/|file:)/.test(s) || /\.(sqlite3?|db|db3)$/i.test(s)) return { type: 'sqlite', file: s.replace(/^file:(\/\/)?/, '').replace(/^~/, os.homedir()) };
  if (/^mongodb(\+srv)?:\/\//i.test(s)) {
    const u = new URL(s.replace(/^mongodb(\+srv)?:/i, 'http:'));
    return { type: 'mongo', uri: /\+srv/i.test(s) || u.host.includes(',') ? s : '', host: u.hostname, port: +u.port || 27017, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1), authSource: u.searchParams.get('authSource') || '' };
  }
  const m = /^(postgres(?:ql)?|mysql|mariadb|db2):\/\//i.exec(s);
  if (!m) return null;
  const type = { postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', db2: 'db2' }[m[1].toLowerCase()];
  const u = new URL(s.replace(/^[a-z0-9]+:/i, 'http:'));
  return {
    type, host: u.hostname, port: +u.port || TYPES[type].port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)), ssl: u.searchParams.get('sslmode') || '',
  };
}

module.exports = { TYPES, makeDriver, detectLocal, parseUrl, probe };
