'use strict';
// Proxy module: rules, plus real round trips through tiny local HTTP-CONNECT and SOCKS5 proxies (no network).
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const { parseProxy, bypasses, parsePacResult, resolveProxy, connectVia, openTunnel, ProxyBridge, describe } = require('../electron/proxy.cjs');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => srv.close(() => r()));

/** Echo server: replies "echo:<data>". */
async function echoServer() {
  const socks = new Set();
  const srv = net.createServer((s) => { socks.add(s); s.on('data', (d) => s.write('echo:' + d)); s.on('error', () => {}); });
  const port = await listen(srv);
  return { port, close: () => { socks.forEach((s) => s.destroy()); return close(srv); } };
}

/** Minimal HTTP CONNECT proxy; records targets; optional basic auth. */
async function httpProxy({ auth } = {}) {
  const seen = [];
  const socks = new Set();
  const srv = http.createServer((q, r) => { r.writeHead(405); r.end(); });
  srv.on('connect', (req, client, head) => {
    socks.add(client);
    seen.push(req.url);
    if (auth && req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(auth).toString('base64')) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    const up = net.connect(+port, host, () => { client.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); client.pipe(up); up.pipe(client); });
    socks.add(up);
    up.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  });
  const port = await listen(srv);
  return { port, seen, close: () => { socks.forEach((s) => s.destroy()); return close(srv); } };
}

/** Minimal SOCKS5 proxy (no auth or user/pass); records targets. */
async function socksProxy({ user, pass } = {}) {
  const seen = [];
  const socks = new Set();
  const srv = net.createServer((c) => {
    socks.add(c); c.on('error', () => {});
    let stage = 0; let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])]; buf = buf.subarray(2 + buf[1]);
        if (user) { if (!methods.includes(2)) return c.end(Buffer.from([5, 0xff])); c.write(Buffer.from([5, 2])); stage = 1; } else { c.write(Buffer.from([5, 0])); stage = 2; }
      }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1]; if (buf.length < 3 + ul) return; const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
        const u = buf.subarray(2, 2 + ul).toString(); const p = buf.subarray(3 + ul, 3 + ul + pl).toString(); buf = buf.subarray(3 + ul + pl);
        if (u !== user || p !== pass) return c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0])); stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        const at = buf[3]; let host; let off;
        if (at === 1) { host = [...buf.subarray(4, 8)].join('.'); off = 8; } else if (at === 3) { if (buf.length < 5 + buf[4] + 2) return; host = buf.subarray(5, 5 + buf[4]).toString(); off = 5 + buf[4]; } else return c.end();
        if (buf.length < off + 2) return;
        const port = buf.readUInt16BE(off); buf = buf.subarray(off + 2);
        seen.push(`${host}:${port}`);
        stage = 3; c.off('data', onData);
        const up = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); if (buf.length) up.write(buf); c.pipe(up); up.pipe(c); });
        socks.add(up);
        up.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    };
    c.on('data', onData);
  });
  const port = await listen(srv);
  return { port, seen, close: () => { socks.forEach((s) => s.destroy()); return close(srv); } };
}

const talk = (sock, msg) => new Promise((resolve) => { sock.once('data', (d) => { resolve(String(d)); sock.destroy(); }); sock.write(msg); });

test('parseProxy and describe', () => {
  assert.deepEqual(parseProxy('proxy.corp:3128'), { kind: 'http', host: 'proxy.corp', port: 3128, user: '', pass: '' });
  assert.deepEqual(parseProxy('socks5://u:p%40ss@10.0.0.1'), { kind: 'socks5', host: '10.0.0.1', port: 1080, user: 'u', pass: 'p@ss' });
  assert.equal(parseProxy('https://p.example').port, 443);
  assert.throws(() => parseProxy('ftp://x:1'), /isn’t supported/);
  assert.throws(() => parseProxy(''), /Enter a proxy/);
  assert.equal(describe(parseProxy('http://bob:secret@p:8080')), 'http://bob@p:8080', 'password never shown');
});

test('no-proxy rules', () => {
  const list = 'localhost, 127.0.0.1, *.local, .corp.example, internal.io, 10.0.0.0/8, db.example:5432, *.blob.core.*';
  assert.ok(bypasses('localhost', 80, list));
  assert.ok(bypasses('printer.local', 80, list));
  assert.ok(bypasses('a.b.corp.example', 443, list));
  assert.ok(bypasses('corp.example', 443, list));
  assert.ok(bypasses('api.internal.io', 443, list));
  assert.ok(!bypasses('notinternal.io', 443, list));
  assert.ok(bypasses('10.20.30.40', 443, list));
  assert.ok(!bypasses('11.0.0.1', 443, list));
  assert.ok(bypasses('db.example', 5432, list));
  assert.ok(!bypasses('db.example', 5433, list));
  assert.ok(bypasses('acc.blob.core.windows.net', 443, list));
  assert.ok(bypasses('anything', 1, '*'));
  assert.ok(bypasses('intranet', 1, '<local>') && !bypasses('a.com', 1, '<local>'));
});

test('PAC answers and resolveProxy modes', async () => {
  assert.equal(parsePacResult('DIRECT'), null);
  assert.deepEqual(parsePacResult('PROXY p.corp:8080; DIRECT'), parseProxy('http://p.corp:8080'));
  assert.equal(parsePacResult('SOCKS5 s:1080').kind, 'socks5');
  assert.equal(await resolveProxy({ mode: 'none', url: 'http://p:1' }, 'a.com', 443), null);
  assert.equal((await resolveProxy({ mode: 'custom', url: 'http://p:1' }, 'a.com', 443)).host, 'p');
  assert.equal(await resolveProxy({ mode: 'custom', url: 'http://p:1' }, 'localhost', 443), null, 'default no-proxy list keeps localhost direct');
  assert.equal(await resolveProxy({ mode: 'custom', url: 'http://p:1', noProxy: '' }, 'localhost', 443) != null, true);
  const asked = [];
  const sys = async (u) => { asked.push(u); return 'PROXY sys.corp:3128'; };
  const p = await resolveProxy({ mode: 'system', user: 'me', pass: 'pw' }, 'management.azure.com', 443, sys);
  assert.deepEqual([p.host, p.port, p.user, p.pass], ['sys.corp', 3128, 'me', 'pw']);
  assert.deepEqual(asked, ['https://management.azure.com:443/']);
});

test('connectVia: direct, HTTP CONNECT (with auth) and SOCKS5 (with auth)', async () => {
  const echo = await echoServer();
  const hp = await httpProxy({ auth: 'bob:pw' });
  const sp = await socksProxy({ user: 'amy', pass: 'pw' });
  try {
    assert.equal(await talk(await connectVia(null, '127.0.0.1', echo.port), 'a'), 'echo:a');
    assert.equal(await talk(await connectVia(parseProxy(`http://bob:pw@127.0.0.1:${hp.port}`), '127.0.0.1', echo.port), 'b'), 'echo:b');
    assert.deepEqual(hp.seen, [`127.0.0.1:${echo.port}`]);
    await assert.rejects(connectVia(parseProxy(`http://127.0.0.1:${hp.port}`), '127.0.0.1', echo.port), /needs a user name and password/);
    await assert.rejects(connectVia(parseProxy(`http://bob:nope@127.0.0.1:${hp.port}`), '127.0.0.1', echo.port), /rejected the user name/);
    assert.equal(await talk(await connectVia(parseProxy(`socks5://amy:pw@127.0.0.1:${sp.port}`), 'localhost', echo.port), 'c'), 'echo:c');
    assert.deepEqual(sp.seen, [`localhost:${echo.port}`], 'host name is sent to the proxy, not resolved locally');
    await assert.rejects(connectVia(parseProxy(`socks5://127.0.0.1:${sp.port}`), 'localhost', echo.port), /needs a user name/);
    await assert.rejects(connectVia(parseProxy(`socks5://amy:x@127.0.0.1:${sp.port}`), 'localhost', echo.port), /rejected the user name/);
    const dead = net.createServer(); const deadPort = await listen(dead); await close(dead);
    await assert.rejects(connectVia(parseProxy(`http://127.0.0.1:${deadPort}`), 'x', 1), /nothing is listening/);
  } finally { await echo.close(); await hp.close(); await sp.close(); }
});

test('openTunnel forwards a local port through the proxy', async () => {
  const echo = await echoServer();
  const sp = await socksProxy();
  const t = await openTunnel(parseProxy(`socks5://127.0.0.1:${sp.port}`), '127.0.0.1', echo.port);
  try {
    const s = net.connect(t.port, t.host);
    await new Promise((r) => s.once('connect', r));
    assert.equal(await talk(s, 'hi'), 'echo:hi');
  } finally { await t.close(); await echo.close(); await sp.close(); }
});

test('ProxyBridge sends each CONNECT where resolve() says', async () => {
  const echo = await echoServer();
  const hp = await httpProxy();
  const decisions = [];
  const bridge = new ProxyBridge(async (host, port) => { decisions.push(host); return host === 'via-proxy.test' ? parseProxy(`http://127.0.0.1:${hp.port}`) : null; });
  const url = new URL(await bridge.start());
  const connect = (target) => new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: target });
    req.on('connect', (res, sock) => resolve({ status: res.statusCode, sock, error: decodeURIComponent(res.headers['x-proxy-error'] || '') }));
    req.on('error', reject); req.end();
  });
  try {
    const a = await connect(`127.0.0.1:${echo.port}`);
    assert.equal(a.status, 200);
    assert.equal(await talk(a.sock, 'direct'), 'echo:direct');
    assert.equal(hp.seen.length, 0);
    const b = await connect(`via-proxy.test:${echo.port}`);
    assert.equal(b.status, 502, 'upstream cannot resolve the fake host, so the bridge reports it');
    assert.deepEqual(hp.seen, [`via-proxy.test:${echo.port}`]);
    assert.ok(b.error);
  } finally { await bridge.stop(); await echo.close(); await hp.close(); }
});

test('routeConnection: app setting, per-connection override and tunnels', async () => {
  const { routeConnection, mongoFirstHost } = require('../electron/netroute.cjs');
  const echo = await echoServer();
  const sp = await socksProxy();
  const appProxy = { mode: 'custom', url: `socks5://127.0.0.1:${sp.port}`, noProxy: 'localhost, *.internal' };
  const base = { type: 'postgres', host: '127.0.0.1', port: echo.port };
  try {
    const sqlite = await routeConnection({ type: 'sqlite', file: '/x.db' }, appProxy);
    assert.equal(sqlite.via, null);

    const r = await routeConnection(base, appProxy, null, 5432);
    assert.equal(r.via, `socks5://127.0.0.1:${sp.port}`);
    assert.equal(r.cfg.host, '127.0.0.1', 'driver keeps the real host for TLS');
    assert.ok(r.cfg.tunnel.port && r.cfg.tunnel.port !== echo.port);
    const s = net.connect(r.cfg.tunnel.port, r.cfg.tunnel.host);
    await new Promise((ok) => s.once('connect', ok));
    assert.equal(await talk(s, 'q'), 'echo:q');
    assert.deepEqual(sp.seen, [`127.0.0.1:${echo.port}`]);
    await r.close();

    const skip = await routeConnection({ ...base, host: 'db.internal' }, appProxy, null, 5432);
    assert.equal(skip.via, null, 'no-proxy list keeps it direct');
    const own = await routeConnection({ ...base, proxyMode: 'none' }, appProxy, null, 5432);
    assert.equal(own.via, null, 'connection says no proxy');
    const off = await routeConnection(base, { mode: 'none' }, null, 5432);
    assert.equal(off.via, null);

    const custom = await routeConnection({ ...base, proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:1' }, { mode: 'none' }, null, 5432);
    assert.equal(custom.via, 'http://127.0.0.1:1');
    // The driver only sees "connection closed"; the route swaps in the proxy's reason.
    const s2 = net.connect(custom.cfg.tunnel.port, custom.cfg.tunnel.host);
    await new Promise((ok) => s2.once('close', ok));
    assert.match(custom.error(new Error('Connection terminated unexpectedly')).message, /nothing is listening at 127\.0\.0\.1:1/);
    await custom.close();

    assert.deepEqual(mongoFirstHost('mongodb+srv://u:p@cluster0.abc.mongodb.net/db'), { host: 'cluster0.abc.mongodb.net', port: 27017, srv: true });
    assert.deepEqual(mongoFirstHost('mongodb://a:1,b:2/x'), { host: 'a', port: 1, srv: false });
    const m = await routeConnection({ type: 'mongo', uri: 'mongodb+srv://cluster0.abc.mongodb.net/db' }, appProxy);
    assert.deepEqual(m.cfg.mongoProxy, { host: '127.0.0.1', port: sp.port, user: '', pass: '' });
    await assert.rejects(routeConnection({ type: 'mongo', uri: 'mongodb://a:1,b:2/x', proxyMode: 'custom', proxyUrl: 'http://p:8080' }, { mode: 'none' }), /only go through a SOCKS5 proxy/);
  } finally { await echo.close(); await sp.close(); }
});
