'use strict';
// Everything Pelican keeps on disk lives in the app's userData folder:
//   config.json       settings, window, MCP settings and per-connection AI access
//   connections.json  connections (passwords in plain text, as asked: this is a local tool)
//   history.jsonl     the Query Manager log
//   scripts/          SQL editor tabs
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = { cache: true, cacheTtlMin: 30, editorMaxRows: 1000, pageSize: 200, showSystem: false, theme: 'system', fontSize: 13, confirmDangerous: true };

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    this.config = this.read('config.json', {});
    this.config.settings = { ...DEFAULT_SETTINGS, ...(this.config.settings || {}) };
    this.config.mcp = { enabled: false, port: 7429, requireToken: true, policies: {}, ...(this.config.mcp || {}) };
    if (!this.config.mcp.token) this.config.mcp.token = crypto.randomBytes(18).toString('base64url');
    this.connections = this.read('connections.json', []);
    this.history = [];
    try {
      const lines = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean);
      this.history = lines.slice(-5000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (lines.length > 8000) fs.writeFileSync(path.join(dir, 'history.jsonl'), this.history.map((h) => JSON.stringify(h)).join('\n') + '\n');
    } catch { /* first run */ }
  }
  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return fallback; }
  }
  write(name, value) {
    const f = path.join(this.dir, name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }
  saveConfig() { this.write('config.json', this.config); }
  saveConnections() { this.write('connections.json', this.connections); }

  upsertConnection(c) {
    const i = this.connections.findIndex((x) => x.id === c.id);
    if (!c.id) c.id = 'c' + crypto.randomBytes(5).toString('hex');
    if (i >= 0) this.connections[i] = c; else this.connections.push(c);
    this.saveConnections();
    return c;
  }
  removeConnection(id) {
    this.connections = this.connections.filter((c) => c.id !== id);
    delete this.config.mcp.policies[id];
    this.saveConnections();
    this.saveConfig();
  }

  addHistory(h) {
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(), ...h };
    if (e.sql && e.sql.length > 20000) e.sql = e.sql.slice(0, 20000) + '…';
    this.history.push(e);
    if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);
    fs.appendFile(path.join(this.dir, 'history.jsonl'), JSON.stringify(e) + '\n', () => {});
    return e;
  }
  clearHistory() { this.history = []; fs.writeFileSync(path.join(this.dir, 'history.jsonl'), ''); }

  // SQL editor tabs survive restarts
  loadScripts() {
    const meta = this.read('scripts/tabs.json', []);
    return meta.map((m) => { let text = ''; try { text = fs.readFileSync(path.join(this.dir, 'scripts', m.id + '.sql'), 'utf8'); } catch { /* new */ } return { ...m, text }; });
  }
  saveScript(s) {
    fs.writeFileSync(path.join(this.dir, 'scripts', s.id.replace(/[^\w-]/g, '') + '.sql'), s.text || '');
  }
  saveScriptTabs(list) { this.write('scripts/tabs.json', list.map(({ text, ...m }) => m)); }
  deleteScript(id) { try { fs.unlinkSync(path.join(this.dir, 'scripts', id.replace(/[^\w-]/g, '') + '.sql')); } catch { /* gone */ } }
}

/** Results of reads, so reopening a table or re-running a query does not hit the database again. */
class ResultCache {
  constructor(maxEntries = 300, maxRows = 400000) { this.map = new Map(); this.maxEntries = maxEntries; this.maxRows = maxRows; this.rows = 0; }
  key(parts) { return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex'); }
  get(key, ttlMs) {
    const e = this.map.get(key);
    if (!e) return null;
    if (ttlMs && Date.now() - e.at > ttlMs) { this.drop(key); return null; }
    this.map.delete(key); this.map.set(key, e); // most recently used goes last
    return e;
  }
  set(key, connId, value) {
    this.drop(key);
    const n = value.rows?.length || 0;
    const e = { at: Date.now(), connId, value, n };
    this.map.set(key, e);
    this.rows += n;
    while ((this.map.size > this.maxEntries || this.rows > this.maxRows) && this.map.size > 1) this.drop(this.map.keys().next().value);
    return e;
  }
  drop(key) { const e = this.map.get(key); if (e) { this.rows -= e.n; this.map.delete(key); } }
  invalidate(connId) { for (const [k, e] of this.map) if (!connId || e.connId === connId) this.drop(k); }
  stats() { return { entries: this.map.size, rows: this.rows }; }
}

module.exports = { Store, ResultCache, DEFAULT_SETTINGS };
