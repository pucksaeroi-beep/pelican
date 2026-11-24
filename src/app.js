// Shared state and a small event bus. Views import `app` and call each other through it.
export const api = window.pelican;

const listeners = new Map();
export const app = {
  state: { connections: [], settings: {}, mcp: {}, types: {}, live: new Map(), errors: new Map() },
  on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); },
  emit(evt, ...a) { for (const fn of listeners.get(evt) || []) { try { fn(...a); } catch (e) { console.error(e); } } },
  conn(id) { return this.state.connections.find((c) => c.id === id); },
  isLive(id) { return this.state.live.has(id); },
  async connect(id) {
    if (this.state.live.has(id)) return this.state.live.get(id);
    this.emit('conn-busy', id, true);
    try {
      const r = await api.conn.connect(id);
      this.state.live.set(id, r.version);
      this.state.errors.delete(id);
      return r.version;
    } catch (e) {
      this.state.errors.set(id, e.message);
      throw e;
    } finally { this.emit('conn-busy', id, false); this.emit('conn-state', id); }
  },
  async setSettings(patch) {
    this.state.settings = await api.settings.set(patch);
    this.emit('settings', this.state.settings);
  },
  /** dialect for a connection type */
  dialectOf(type) { return { postgres: 'pg', mysql: 'mysql', sqlite: 'sqlite', mongo: 'mongo', db2: 'db2' }[type]; },
  /** "schema.table" as the engine writes it */
  qualified(conn, schema, table) {
    const d = this.dialectOf(conn.type);
    const q = (s) => (d === 'mysql' ? '`' + s.replace(/`/g, '``') + '`' : /^[a-z_][a-z0-9_]*$/.test(s) || (d === 'db2' && /^[A-Z_][A-Z0-9_]*$/.test(s)) ? s : '"' + s.replace(/"/g, '""') + '"');
    if (d === 'sqlite' && (schema === 'main' || !schema)) return q(table);
    return `${q(schema)}.${q(table)}`;
  },
};
