'use strict';
// Builds the SELECTs behind a table's Data tab: the "SQL expression" filter box, per-column filters,
// sorting and paging. Values always go in as parameters.
const { quoteIdent, qualified, placeholder } = require('../lib/sqltext.cjs');

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

module.exports = { buildSelect, buildCount, buildDistinct, buildDistinctWrapped, wrapQuery, whereClause };
