'use strict';
// SQL text helpers shared by the drivers, the MCP server and the tests: statement splitting,
// keyword scanning that ignores strings and comments, identifier quoting and literal escaping.

/** Walk the text and call onCode(i) for every character that is real SQL (not in a string or comment). */
function scan(text, dialect, onChar) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '-' && d === '-') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '#' && dialect === 'mysql') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"' || (c === '`' && dialect === 'mysql')) {
      const start = i;
      i++;
      while (i < n) {
        if (text[i] === '\\' && dialect === 'mysql' && c !== '`') { i += 2; continue; }
        if (text[i] === c) { if (text[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++;
      onChar(start, c === "'" ? 'string' : 'ident', i);
      continue;
    }
    if (c === '$' && dialect === 'pg') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = text.indexOf(tag, i + tag.length);
        const end = e < 0 ? n : e + tag.length;
        onChar(i, 'string', end);
        i = end;
        continue;
      }
    }
    onChar(i, 'code', i + 1);
    i++;
  }
}

/** Split a script into statements on top-level semicolons. Returns [{sql, start, end}] with offsets into text. */
function splitStatements(text, dialect = 'pg') {
  const out = [];
  let start = 0;
  let depth = 0; // BEGIN ... END blocks (triggers / procedures) keep their inner semicolons
  let word = '';
  let wordStart = -1;
  const flushWord = () => {
    if (!word) return;
    const w = word.toLowerCase();
    if (w === 'begin' && depth >= 0 && /\b(create|replace)\b[\s\S]*\b(trigger|procedure|function)\b/i.test(text.slice(start, wordStart))) depth++;
    else if (w === 'case' && depth > 0) depth++;
    else if (w === 'end' && depth > 0) depth--;
    word = '';
  };
  scan(text, dialect, (i, kind) => {
    if (kind !== 'code') { flushWord(); return; }
    const ch = text[i];
    if (/[A-Za-z0-9_]/.test(ch)) { if (!word) wordStart = i; word += ch; return; }
    flushWord();
    if (ch === ';' && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  });
  flushWord();
  push(start, text.length);
  function push(a, b) {
    const raw = text.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const sql = raw.trim();
    if (sql && !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(sql)) out.push({ sql, start: a + lead, end: a + lead + sql.length });
  }
  return out;
}

/** Statement under the cursor (or the last one before it). */
function statementAt(text, offset, dialect) {
  const all = splitStatements(text, dialect);
  if (!all.length) return null;
  let best = all[0];
  for (const s of all) {
    if (s.start <= offset) best = s;
    if (offset >= s.start && offset <= s.end + 1) return s;
  }
  return best;
}

/** Lower-case words of the statement that are real SQL keywords/identifiers (strings and comments removed). */
function codeWords(sql, dialect) {
  let code = '';
  scan(sql, dialect, (i, kind, end) => { code += kind === 'code' ? sql[i] : ' '; if (kind !== 'code') code += ' '.repeat(Math.max(0, end - i - 1)); });
  return code.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) || [];
}

const READ_START = new Set(['select', 'with', 'show', 'explain', 'describe', 'desc', 'values', 'table', 'pragma']);
// Reserved words that only appear in a write (an unquoted column can't be called this), plus functions with side
// effects. pg / MySQL / SQLite also run MCP reads in a read-only transaction or handle, so this is a second wall;
// for DB2 it is the main one.
const WRITE_WORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'create', 'drop', 'alter', 'truncate', 'grant', 'revoke', 'call', 'into',
  'outfile', 'dumpfile', 'nextval', 'setval', 'pg_terminate_backend', 'pg_cancel_backend', 'lo_import', 'lo_export',
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_write_file', 'dblink', 'dblink_exec', 'load_extension',
  'set_config', 'pg_advisory_lock', 'pg_notify',
]);
// words that are fine inside a read query even though they look like the ones above
const PRAGMA_READ = /^pragma\s+(table_info|table_xinfo|index_list|index_info|foreign_key_list|database_list|table_list)\b/i;

/** Conservative read-only check used by the MCP server: one statement, starts like a read, no write words. */
function readOnlyProblem(sql, dialect) {
  const stmts = splitStatements(sql, dialect);
  if (stmts.length !== 1) return stmts.length ? 'Only one statement per call is allowed.' : 'Empty query.';
  const words = codeWords(stmts[0].sql, dialect);
  const first = words[0];
  if (!READ_START.has(first)) return `"${first}" is not a read statement. This connection is read-only.`;
  if (first === 'pragma' && !PRAGMA_READ.test(stmts[0].sql)) return 'Only informational PRAGMAs are allowed.';
  if (first === 'explain' && words.includes('analyze')) return 'EXPLAIN ANALYZE runs the statement; use explain with analyze=false.';
  const bad = words.slice(1).find((w) => WRITE_WORDS.has(w));
  if (bad) return `"${bad.toUpperCase()}" is not allowed on a read-only connection.`;
  return null;
}

function statementKind(sql, dialect) {
  const w = codeWords(sql, dialect)[0] || '';
  return READ_START.has(w) ? 'read' : 'write';
}

// ---------- quoting ----------
function quoteIdent(name, dialect) {
  const s = String(name);
  if (dialect === 'mysql') return '`' + s.replace(/`/g, '``') + '`';
  return '"' + s.replace(/"/g, '""') + '"';
}
function qualified(schema, table, dialect) {
  if (dialect === 'sqlite' && (!schema || schema === 'main')) return quoteIdent(table, dialect);
  return schema ? quoteIdent(schema, dialect) + '.' + quoteIdent(table, dialect) : quoteIdent(table, dialect);
}
/** A literal for dump files. */
function literal(v, dialect) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${v}'`;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return dialect === 'pg' ? (v ? 'TRUE' : 'FALSE') : (v ? '1' : '0');
  if (v instanceof Date) return `'${isoLocal(v, dialect)}'`;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const hex = Buffer.from(v).toString('hex');
    if (dialect === 'pg') return `'\\x${hex}'`;
    if (dialect === 'db2') return `BX'${hex}'`;
    return `X'${hex}'`;
  }
  if (typeof v === 'object') v = JSON.stringify(v);
  let s = String(v).replace(/'/g, "''");
  if (dialect === 'mysql') s = s.replace(/\\/g, '\\\\');
  if (dialect === 'pg' && /[\0]/.test(s)) s = s.replace(/\0/g, '');
  return `'${s}'`;
}
function isoLocal(d, dialect) {
  const iso = d.toISOString();
  return dialect === 'mysql' || dialect === 'db2' ? iso.replace('T', ' ').replace('Z', '') : iso;
}

/** Placeholder for the n-th (1-based) parameter. */
const placeholder = (dialect, n) => (dialect === 'pg' ? '$' + n : '?');

/** Strip a trailing semicolon and comments at the end so the text can be wrapped in a subquery. */
function bareStatement(sql) {
  return String(sql).trim().replace(/;+\s*$/, '');
}

module.exports = { scan, splitStatements, statementAt, codeWords, readOnlyProblem, statementKind, quoteIdent, qualified, literal, placeholder, bareStatement };
