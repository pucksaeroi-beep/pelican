'use strict';
// Where a database connection goes: straight to the server, or through an HTTP / SOCKS5 proxy.
// Drivers only know host + port, so a proxied connection gets a local tunnel on 127.0.0.1 that forwards
// through the proxy; TLS still checks the real server name.
const { normalize, resolveProxy, openTunnel, describe } = require('./proxy.cjs');

/** Proxy settings for one connection: its own choice, or the app setting. */
function proxySettingsFor(conn, appProxy) {
  if (conn.proxyMode === 'none') return { mode: 'none' };
  if (conn.proxyMode === 'custom') return { mode: 'custom', url: conn.proxyUrl, noProxy: '' };
  return normalize(appProxy);
}

function mongoFirstHost(uri) {
  const m = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri || '');
  if (!m) return null;
  const first = m[2].split(',')[0];
  const hp = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(first);
  return { host: hp[1], port: +hp[2] || 27017, srv: !!m[1] };
}

/**
 * Resolves the route for `cfg`. Returns { cfg, via, close, error(e) }:
 * cfg is what the driver gets, via describes the proxy (null = direct), close() frees the tunnel,
 * error(e) swaps a driver's "connection closed" for the proxy's own message.
 */
async function routeConnection(cfg, appProxy, lookup, defaultPort) {
  const direct = { cfg, via: null, close: async () => {}, error: (e) => e };
  if (cfg.type === 'sqlite') return direct;
  const settings = proxySettingsFor(cfg, appProxy);
  if (settings.mode === 'none') return direct;

  if (cfg.type === 'mongo' && cfg.uri) {
    const first = mongoFirstHost(cfg.uri);
    if (!first) return direct;
    const proxy = await resolveProxy(settings, first.host, first.port, lookup);
    if (!proxy) return direct;
    if (proxy.kind !== 'socks5') throw new Error('A MongoDB connection string (mongodb+srv or several hosts) can only go through a SOCKS5 proxy. Use socks5://… or fill in host and port instead.');
    return { ...direct, cfg: { ...cfg, mongoProxy: { host: proxy.host, port: proxy.port, user: proxy.user, pass: proxy.pass } }, via: describe(proxy) };
  }

  const host = cfg.host || '127.0.0.1';
  const port = +cfg.port || defaultPort;
  const proxy = await resolveProxy(settings, host, port, lookup);
  if (!proxy) return direct;
  const t = await openTunnel(proxy, host, port);
  return {
    cfg: { ...cfg, host, port, tunnel: { host: t.host, port: t.port } },
    via: describe(proxy),
    close: () => t.close(),
    error: (e) => {
      if (!t.lastError) return e;
      const err = new Error(t.lastError.message);
      err.cause = e;
      return err;
    },
  };
}

/** Host and port that outside tools (pg_dump, mysqldump) should use. */
function endpoint(cfg) { return cfg.tunnel ? { host: cfg.tunnel.host, port: cfg.tunnel.port } : { host: cfg.host, port: cfg.port }; }

module.exports = { routeConnection, proxySettingsFor, mongoFirstHost, endpoint };
