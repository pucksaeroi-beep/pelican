'use strict';
// Builds the SELECTs behind a table's Data tab: the "SQL expression" filter box, per-column filters,
// sorting and paging. Values always go in as parameters.
const { quoteIdent, qualified, placeholder, literal } = require('../lib/sqltext.cjs');

const OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function asText(col, dialect) {
  if (dialect === 'pg') return `${col}::text`;
  if (dialect === 'db2') return `CAST(${col} AS VARCHAR(4000))`;
  return col;
}

/**
 * filters: [{ col, op: 'in'|'nin'|'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|'starts'|'null'|'notnull', values: [] }]
 * where: a raw SQL expression typed by the user (their own database, their own SQL).
 */
function whereClause({ dialect, where, filters = [] }, params) {
  const p = (v) => { params.push(v); return placeholder(dialect, params.length); };
  const parts = [];
  if (where && String(where).trim()) parts.push(`(${String(where).trim()})`);
  for (const f of filters) {
    const c = quoteIdent(f.col, dialect);
    const vals = f.values || [];
    if (f.op === 'in' || f.op === 'nin') {
      const nonNull = vals.filter((v) => v !== null);
      const hasNull = nonNull.length !== vals.length;
      const list = nonNull.length ? `${asText(c, dialect)} IN (${nonNull.map((v) => p(String(v))).join(', ')})` : null;
      if (f.op === 'in') {
        if (!list && !hasNull) parts.push('1 = 0');
        else parts.push('(' + [list, hasNull ? `${c} IS NULL` : null].filter(Boolean).join(' OR ') + ')');
      } else if (list) parts.push(hasNull ? `NOT ${list}` : `(NOT ${list} OR ${c} IS NULL)`); // NULL NOT IN (..) is unknown
      else if (hasNull) parts.push(`${c} IS NOT NULL`);
    } else if (OPS[f.op]) parts.push(`${c} ${OPS[f.op]} ${p(vals[0])}`);
    else if (f.op === 'contains') parts.push(`${asText(c, dialect)} ${dialect === 'pg' ? 'ILIKE' : 'LIKE'} ${p('%' + vals[0] + '%')}`);
    else if (f.op === 'starts') parts.push(`${asText(c, dialect)} ${dialect === 'pg' ? 'ILIKE' : 'LIKE'} ${p(vals[0] + '%')}`);
    else if (f.op === 'null') parts.push(`${c} IS NULL`);
    else if (f.op === 'notnull') parts.push(`${c} IS NOT NULL`);
  }
  return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
}

function buildSelect(o) {
  const { dialect, schema, table, order = [], limit = 200, offset = 0 } = o;
  const params = [];
  let sql = `SELECT * FROM ${qualified(schema, table, dialect)}` + whereClause(o, params);
  if (order.length) sql += ' ORDER BY ' + order.map((s) => `${quoteIdent(s.col, dialect)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
  if (dialect === 'db2') sql += (offset ? ` OFFSET ${offset | 0} ROWS` : '') + ` FETCH FIRST ${limit | 0} ROWS ONLY`;
  else sql += ` LIMIT ${limit | 0}` + (offset ? ` OFFSET ${offset | 0}` : '');
  return { sql, params };
}

function buildCount(o) {
  const params = [];
  return { sql: `SELECT COUNT(*) AS n FROM ${qualified(o.schema, o.table, o.dialect)}` + whereClause(o, params), params };
}

/** Distinct values with counts for a column's filter popover (other filters still apply). */
function buildDistinct(o) {
  const { dialect, col } = o;
  const params = [];
  const c = quoteIdent(col, dialect);
  const filters = (o.filters || []).filter((f) => f.col !== col);
  const where = whereClause({ ...o, filters }, params);
  const lim = o.limit || 300;
  const tail = dialect === 'db2' ? ` FETCH FIRST ${lim} ROWS ONLY` : ` LIMIT ${lim}`;
  return { sql: `SELECT ${c} AS v, COUNT(*) AS n FROM ${qualified(o.schema, o.table, dialect)}${where} GROUP BY ${c} ORDER BY 2 DESC, 1${tail}`, params };
}

/** Distinct values of a column of an arbitrary query's result. */
function buildDistinctWrapped(o) {
  const { dialect, col, sql } = o;
  const params = [];
  const c = quoteIdent(col, dialect);
  const inner = String(sql).trim().replace(/;+\s*$/, '');
  const where = whereClause({ ...o, filters: (o.filters || []).filter((f) => f.col !== col) }, params);
  const tail = dialect === 'db2' ? ' FETCH FIRST 300 ROWS ONLY' : ' LIMIT 300';
  return { sql: `SELECT ${c} AS v, COUNT(*) AS n FROM (${inner}) ${dialect === 'mysql' ? '`q`' : 'q'}${where} GROUP BY ${c} ORDER BY 2 DESC, 1${tail}`, params };
}

/** Wrap an arbitrary SELECT so the result grid's filter box and column filters can be applied server-side. */
function wrapQuery(o) {
  const { dialect, sql, order = [], limit } = o;
  const params = [];
  const inner = String(sql).trim().replace(/;+\s*$/, '');
  let out = `SELECT * FROM (${inner}) ${dialect === 'mysql' ? '`q`' : 'q'}` + whereClause(o, params);
  if (order.length) out += ' ORDER BY ' + order.map((s) => `${quoteIdent(s.col, dialect)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
  if (limit) out += dialect === 'db2' ? ` FETCH FIRST ${limit | 0} ROWS ONLY` : ` LIMIT ${limit | 0}`;
  return { sql: out, params };
}

/**
 * Statements that save edits made in the grid. Each one must touch exactly one row, or the whole batch rolls back.
 * changes: [{ op: 'update', key: [{ col, v }], set: [{ col, v }] } | { op: 'insert', values: [{ col, v }] } | { op: 'delete', key }]
 */
function buildEdits({ dialect, schema, table, changes }) {
  const t = qualified(schema, table, dialect);
  const q = (c) => quoteIdent(c, dialect);
  return changes.map((ch, i) => {
    const params = [];
    const p = (v) => { params.push(v); return placeholder(dialect, params.length); };
    const match = (key) => {
      if (!key?.length) throw new Error('A row to change has no key columns.');
      return key.map((k) => (k.v === null ? `${q(k.col)} IS NULL` : `${q(k.col)} = ${p(k.v)}`)).join(' AND ');
    };
    const what = `Change ${i + 1} (${ch.op})`;
    if (ch.op === 'update') {
      if (!ch.set?.length) throw new Error('Nothing to update.');
      const set = ch.set.map((c) => `${q(c.col)} = ${c.v === null ? 'NULL' : p(c.v)}`).join(', ');
      return { sql: `UPDATE ${t} SET ${set} WHERE ${match(ch.key)}`, params, expect: 1, what };
    }
    if (ch.op === 'delete') return { sql: `DELETE FROM ${t} WHERE ${match(ch.key)}`, params, expect: 1, what };
    if (ch.op === 'insert') {
      const vals = ch.values || [];
      if (!vals.length) {
        const sql = dialect === 'mysql' ? `INSERT INTO ${t} () VALUES ()` : dialect === 'db2' ? `INSERT INTO ${t} (${q(ch.firstCol)}) VALUES (DEFAULT)` : `INSERT INTO ${t} DEFAULT VALUES`;
        return { sql, params, expect: 1, what };
      }
      return { sql: `INSERT INTO ${t} (${vals.map((c) => q(c.col)).join(', ')}) VALUES (${vals.map((c) => (c.v === null ? 'NULL' : p(c.v))).join(', ')})`, params, expect: 1, what };
    }
    throw new Error(`Unknown change: ${ch.op}`);
  });
}

/** The same statements with values written in, to show the user before saving. */
function editsText(o) {
  return buildEdits(o).map((st) => {
    let i = 0;
    const sql = o.dialect === 'pg' ? st.sql.replace(/\$(\d+)/g, (m, n) => literal(st.params[n - 1], o.dialect)) : st.sql.replace(/\?/g, () => literal(st.params[i++], o.dialect));
    return sql + ';';
  }).join('\n');
}

module.exports = { buildSelect, buildCount, buildDistinct, buildDistinctWrapped, wrapQuery, whereClause, buildEdits, editsText };
