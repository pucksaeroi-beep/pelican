// Statement splitting for the editor. Same code as electron/lib/sqltext.cjs (test/sqltext.test.cjs keeps them in sync).
/** Walk the text and call onCode(i) for every character that is real SQL (not in a string or comment). */
export function scan(text, dialect, onChar) {
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
export function splitStatements(text, dialect = 'pg') {
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
export function statementAt(text, offset, dialect) {
  const all = splitStatements(text, dialect);
  if (!all.length) return null;
  let best = all[0];
  for (const s of all) {
    if (s.start <= offset) best = s;
    if (offset >= s.start && offset <= s.end + 1) return s;
  }
  return best;
}

