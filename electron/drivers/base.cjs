'use strict';
// What every driver returns, plus helpers they share.
//
// Address of an object: { db, schema, table }. `db` is only used by servers that hold several databases
// behind one connection (PostgreSQL, MongoDB); for MySQL the "schema" is the database.
//
// query()  → { columns: [{ name, type }], rows: [[...]], affected, truncated, command }
// explain()→ { kind, plan: PlanNode, text }  PlanNode = { label, detail, cost, rows, actualRows, time, loops, props, children }

const MAX_CELL = 20000; // characters kept per cell in the grid (dumps never truncate)

function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_CELL ? v.slice(0, MAX_CELL) + '…' : v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v);
    return '0x' + b.subarray(0, 64).toString('hex') + (b.length > 64 ? `… (${b.length} bytes)` : '');
  }
  if (v && typeof v === 'object' && v._bsontype) return bsonText(v);
  try { const s = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x && x._bsontype ? bsonText(x) : x)); return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…' : s; }
  catch { return String(v); }
}
function bsonText(v) {
  if (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID') return v.toHexString();
  if (v._bsontype === 'Decimal128' || v._bsontype === 'Long' || v._bsontype === 'Double' || v._bsontype === 'Int32') return v.toString();
  if (v._bsontype === 'Binary') return '0x' + Buffer.from(v.buffer).subarray(0, 64).toString('hex');
  return String(v);
}

/** Run tasks one at a time (a single client connection can only do one thing). */
class Queue {
  constructor() { this.tail = Promise.resolve(); }
  run(fn) { const p = this.tail.then(fn, fn); this.tail = p.catch(() => {}); return p; }
}

/** Turn a plain-text indented plan ("-> Nested loop ... (cost=.. rows=..)") into a tree. Used for MySQL. */
function treeFromIndented(lines, parseLine) {
  const root = { label: 'Plan', children: [], props: {} };
  const stack = [{ indent: -1, node: root }];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.search(/\S/);
    const node = { children: [], props: {}, ...parseLine(raw.trim()) };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root.children.length === 1 ? root.children[0] : root;
}

module.exports = { cell, Queue, treeFromIndented, MAX_CELL };
