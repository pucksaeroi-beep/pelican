'use strict';
// Proxy support with no dependencies: proxy URLs, "no proxy" rules, dialing through an HTTP(S) CONNECT or
// SOCKS5 proxy, a local TCP tunnel (for clients that only take host + port) and a local HTTP proxy bridge
// (for HTTP clients that take a proxy address). The same file is used by Halcyon and Pelican.
const net = require('net');
const tls = require('tls');
const http = require('http');

const DEFAULT_NO_PROXY = 'localhost, 127.0.0.1, ::1, *.local';
const MODES = ['none', 'system', 'custom'];

/** Normalised proxy settings: { mode, url, noProxy, user, pass }. user/pass are for proxies that ask for a sign-in. */
function normalize(cfg = {}) {
  const mode = MODES.includes(cfg?.mode) ? cfg.mode : 'none';
  return {
    mode, url: String(cfg?.url || '').trim(), noProxy: cfg?.noProxy == null ? DEFAULT_NO_PROXY : String(cfg.noProxy),
    user: String(cfg?.user || ''), pass: String(cfg?.pass || ''),
  };
}

/** "http://user:pass@host:8080", "socks5://host:1080", "host:3128" → { kind, host, port, user, pass }. */
function parseProxy(text) {
  let s = String(text || '').trim();
  if (!s) throw new Error('Enter a proxy address, e.g. http://proxy.example.com:8080');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error(`“${text}” is not a proxy address. Use http://host:port or socks5://host:port`); }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  const kind = { http: 'http', https: 'https', socks: 'socks5', socks5: 'socks5', socks5h: 'socks5' }[scheme];
  if (!kind) throw new Error(`Proxy type “${scheme}” isn’t supported. Use http://, https:// or socks5://`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('The proxy address needs a host name.');
  const port = +u.port || { http: 80, https: 443, socks5: 1080 }[kind];
  return { kind, host, port, user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
}

/** Proxy URL without the password, for showing in the UI and in errors. */
function describe(p) {
  if (!p) return 'direct';
  const scheme = p.kind === 'socks5' ? 'socks5' : p.kind;
  return `${scheme}://${p.user ? p.user + '@' : ''}${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`;
}

function ipv4ToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0; }

/** True when `host` (and optionally `port`) matches the comma/space separated "no proxy" list. */
function bypasses(host, port, list) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  for (let rule of String(list || '').split(/[\s,;]+/)) {
    rule = rule.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    if (rule === '<local>') { if (!h.includes('.') && !net.isIP(h)) return true; continue; }
    let rport = null;
    const pm = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(rule);
    if (pm) { rule = pm[1].replace(/^\[|\]$/g, ''); rport = +pm[2]; }
    if (rport && port && rport !== +port) continue;
    if (rule.includes('/') && net.isIPv4(h)) {
      const [base, bits] = rule.split('/');
      if (net.isIPv4(base)) {
        const mask = +bits === 0 ? 0 : (~0 << (32 - +bits)) >>> 0;
        if ((ipv4ToInt(h) & mask) === (ipv4ToInt(base) & mask)) return true;
      }
      continue;
    }
    if (rule.includes('*') && !/^\*\.[^*]+$/.test(rule)) {
      const re = new RegExp('^' + rule.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      if (re.test(h)) return true;
      continue;
    }
    const r = rule.replace(/^\*?\./, '');
    if (h === r || h.endsWith('.' + r)) return true;
  }
  return false;
}

/** First usable entry of a Chromium/PAC answer such as "PROXY p:8080; DIRECT" → proxy or null (direct). */
function parsePacResult(text) {
  for (const part of String(text || '').split(';')) {
    const m = /^\s*(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS|DIRECT)\s*(\S*)\s*$/i.exec(part);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    if (kind === 'DIRECT') return null;
    const scheme = { PROXY: 'http', HTTPS: 'https' }[kind] || 'socks5';
    try { return parseProxy(`${scheme}://${m[2]}`); } catch { /* try the next one */ }
  }
  return null;
}

/**
 * The proxy to use for host:port under `cfg` (or null for a direct connection).
 * `systemLookup(url)` answers like Electron's session.resolveProxy() and is needed for mode "system".
 */
async function resolveProxy(cfg, host, port, systemLookup) {
  const c = normalize(cfg);
  if (c.mode === 'none' || bypasses(host, port, c.noProxy)) return null;
  let p = null;
  if (c.mode === 'custom') p = parseProxy(c.url);
  else if (systemLookup) {
    const scheme = +port === 80 ? 'http' : 'https';
    const hostPart = host.includes(':') ? `[${host}]` : host;
    p = parsePacResult(await systemLookup(`${scheme}://${hostPart}:${port}/`));
  }
  if (p && !p.user && c.user) Object.assign(p, { user: c.user, pass: c.pass }); // sign-in typed in the app
  return p;
}

/** Reads exactly what a handshake needs from a socket, then hands the rest back. */
function reader(sock) {
  let buf = Buffer.alloc(0);
  let wait = null;
  const onData = (d) => { buf = Buffer.concat([buf, d]); check(); };
  const onEnd = () => { if (wait) { const w = wait; wait = null; w.reject(new Error('The proxy closed the connection.')); } };
  const check = () => {
    if (!wait) return;
    const n = wait.n != null ? wait.n : (buf.indexOf('\r\n\r\n') >= 0 ? buf.indexOf('\r\n\r\n') + 4 : -1);
    if (n < 0 || buf.length < n) { if (buf.length > 64 * 1024) onEnd(); return; }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    const w = wait; wait = null; w.resolve(out);
  };
  sock.on('data', onData); sock.on('end', onEnd); sock.on('close', onEnd); sock.on('error', onEnd);
  const read = (n) => new Promise((resolve, reject) => { wait = { n, resolve, reject }; check(); });
  return {
    bytes: (n) => read(n),
    head: () => read(null),
    done() {
      sock.off('data', onData); sock.off('end', onEnd); sock.off('close', onEnd); sock.off('error', onEnd);
      if (buf.length) sock.unshift(buf);
    },
  };
}

const SOCKS_ERRORS = {
  1: 'general failure', 2: 'connection not allowed by its rules', 3: 'network unreachable', 4: 'host unreachable',
  5: 'connection refused by the destination', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported',
};

/** Opens a raw TCP socket to host:port through `proxy` (or directly when proxy is null). */
function connectVia(proxy, host, port, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let sock;
    let settled = false;
    const fail = (e) => {
      if (settled) return; settled = true;
      if (sock) sock.destroy();
      const err = e instanceof Error ? e : new Error(String(e));
      if (proxy && !/proxy/i.test(err.message)) err.message = `Proxy ${describe(proxy)}: ${err.message}`;
      reject(err);
    };
    const ok = () => { if (settled) return; settled = true; sock.setTimeout(0); resolve(sock); };
    if (!proxy) {
      sock = net.connect({ host, port: +port });
      sock.setTimeout(timeout, () => fail(new Error(`Timed out connecting to ${host}:${port}`)));
      sock.once('connect', ok);
      sock.once('error', fail);
      return;
    }
    sock = proxy.kind === 'https'
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host })
      : net.connect({ host: proxy.host, port: proxy.port });
    sock.setTimeout(timeout, () => fail(new Error('timed out')));
    sock.once('error', (e) => fail(e.code === 'ECONNREFUSED' ? new Error(`nothing is listening at ${proxy.host}:${proxy.port}`) : e.code === 'ENOTFOUND' ? new Error(`can’t find the proxy host ${proxy.host}`) : e));
    sock.once(proxy.kind === 'https' ? 'secureConnect' : 'connect', async () => {
      const rd = reader(sock);
      try {
        if (proxy.kind === 'socks5') await socks5(sock, rd, proxy, host, port);
        else await httpConnect(sock, rd, proxy, host, port);
        rd.done();
        ok();
      } catch (e) { fail(e); }
    });
  });
}

async function httpConnect(sock, rd, proxy, host, port) {
  const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const auth = proxy.user ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64')}\r\n` : '';
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}User-Agent: Mozilla/5.0 (Macintosh)\r\n\r\n`);
  const head = (await rd.head()).toString('latin1');
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*([^\r\n]*)/.exec(head);
  const code = m ? +m[1] : 0;
  if (code >= 200 && code < 300) return;
  if (code === 407) throw new Error(proxy.user ? 'Proxy rejected the user name or password (407)' : 'Proxy needs a user name and password (407). Use http://user:pass@host:port');
  throw new Error(`Proxy refused ${target}: ${m ? `${m[1]} ${m[2]}`.trim() : 'not an HTTP proxy'}`);
}

async function socks5(sock, rd, proxy, host, port) {
  const methods = proxy.user ? [0x00, 0x02] : [0x00];
  sock.write(Buffer.from([5, methods.length, ...methods]));
  const [ver, method] = await rd.bytes(2);
  if (ver !== 5) throw new Error('Proxy is not a SOCKS5 proxy');
  if (method === 0xff) throw new Error(proxy.user ? 'SOCKS proxy accepts none of our sign-in methods' : 'SOCKS proxy needs a user name and password. Use socks5://user:pass@host:port');
  if (method === 0x02) {
    const u = Buffer.from(proxy.user || ''); const p = Buffer.from(proxy.pass || '');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const [, status] = await rd.bytes(2);
    if (status !== 0) throw new Error('SOCKS proxy rejected the user name or password');
  }
  let addr;
  if (net.isIPv4(host)) addr = Buffer.from([1, ...host.split('.').map(Number)]);
  else if (net.isIPv6(host)) {
    const full = expandIPv6(host);
    addr = Buffer.concat([Buffer.from([4]), Buffer.from(full.flatMap((g) => [g >> 8, g & 255]))]);
  } else { const name = Buffer.from(host); addr = Buffer.concat([Buffer.from([3, name.length]), name]); }
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([(+port >> 8) & 255, +port & 255])]));
  const [v, rep, , atyp] = await rd.bytes(4);
  if (v !== 5) throw new Error('Bad reply from the SOCKS proxy');
  if (rep !== 0) throw new Error(`SOCKS proxy could not reach ${host}:${port}: ${SOCKS_ERRORS[rep] || 'error ' + rep}`);
  const len = atyp === 1 ? 4 : atyp === 4 ? 16 : (await rd.bytes(1))[0];
  await rd.bytes(len + 2);
}

function expandIPv6(ip) {
  const [a, b = ''] = ip.split('::');
  const left = a ? a.split(':') : []; const right = b ? b.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((g) => parseInt(g || '0', 16));
}

/**
 * A local TCP listener on 127.0.0.1 that forwards every connection to host:port through `proxy`.
 * For database drivers, which only know host + port. `lastError` keeps the latest proxy failure so the
 * caller can show it instead of the driver's "connection closed".
 */
async function openTunnel(proxy, host, port) {
  const t = { host: '127.0.0.1', port: 0, lastError: null, sockets: new Set() };
  const server = net.createServer((client) => {
    client.pause();
    t.sockets.add(client);
    client.on('close', () => t.sockets.delete(client));
    client.on('error', () => {});
    connectVia(proxy, host, port).then((up) => {
      t.sockets.add(up);
      up.on('close', () => { t.sockets.delete(up); client.destroy(); });
      up.on('error', () => client.destroy());
      client.on('close', () => up.destroy());
      client.pipe(up); up.pipe(client);
      client.resume();
    }, (e) => { t.lastError = e; client.destroy(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.port = server.address().port;
  t.close = () => new Promise((resolve) => { for (const s of t.sockets) s.destroy(); server.close(() => resolve()); });
  return t;
}

/**
 * A local HTTP proxy on 127.0.0.1 that HTTP clients (Azure CLI, the Azure SDK, fetch) point at.
 * For each CONNECT it asks `resolve(host, port)` where to go: null = direct, or a proxy from parseProxy().
 */
class ProxyBridge {
  constructor(resolve) {
    this.resolve = resolve;
    this.sockets = new Set();
    this.server = null;
    this.lastError = null;
  }

  get url() { return this.server ? `http://127.0.0.1:${this.server.address().port}` : null; }

  async start() {
    if (this.server) return this.url;
    const server = http.createServer((req, res) => {
      res.writeHead(405, { 'content-type': 'text/plain' }); res.end('Only CONNECT is supported');
    });
    server.on('connect', async (req, client, head) => {
      this.sockets.add(client);
      client.on('close', () => this.sockets.delete(client));
      client.on('error', () => {});
      const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
      if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      const [, host, port] = m;
      try {
        const up = await connectVia(await this.resolve(host, +port), host, +port);
        this.sockets.add(up);
        up.on('close', () => { this.sockets.delete(up); client.destroy(); });
        up.on('error', () => client.destroy());
        client.on('close', () => up.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head);
        client.pipe(up); up.pipe(client);
      } catch (e) {
        e.at = Date.now();
        this.lastError = e;
        const msg = String(e.message).replace(/[\r\n]+/g, ' ').slice(0, 300);
        client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nX-Proxy-Error: ${encodeURIComponent(msg)}\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.server = server;
    return this.url;
  }

  async stop() {
    if (!this.server) return;
    for (const s of this.sockets) s.destroy();
    const s = this.server; this.server = null;
    await new Promise((resolve) => s.close(() => resolve()));
  }
}

/**
 * Checks a proxy setting end to end: opens a TLS connection to host:443 through it.
 * Returns { ok, via, ms } or { ok:false, error }.
 */
async function testProxy(cfg, host, port = 443, systemLookup) {
  const t0 = Date.now();
  let proxy = null;
  try {
    proxy = await resolveProxy(cfg, host, port, systemLookup);
    const sock = await connectVia(proxy, host, port);
    if (+port === 443) {
      await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: host }, () => { s.destroy(); resolve(); });
        s.once('error', reject);
        s.setTimeout(10000, () => { s.destroy(); reject(new Error('TLS handshake timed out')); });
      });
    } else sock.destroy();
    return { ok: true, via: describe(proxy), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, via: describe(proxy), error: e.message, ms: Date.now() - t0 };
  }
}

module.exports = { DEFAULT_NO_PROXY, MODES, normalize, parseProxy, describe, bypasses, parsePacResult, resolveProxy, connectVia, openTunnel, ProxyBridge, testProxy };
