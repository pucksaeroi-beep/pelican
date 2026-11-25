// CodeMirror 6 set up for SQL (per dialect) and MongoDB shell JavaScript.
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, ViewPlugin, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldGutter } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion, completionStatus } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { sql, PostgreSQL, MySQL, SQLite, StandardSQL } from '@codemirror/lang-sql';
import { javascript } from '@codemirror/lang-javascript';
import { tags as t } from '@lezer/highlight';

const style = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-kw)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-str)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.propertyName], color: 'var(--syn-prop)' },
  { tag: [t.special(t.name)], color: 'var(--syn-ident)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--syn-punct)' },
]);

const DIALECTS = { pg: PostgreSQL, mysql: MySQL, sqlite: SQLite, db2: StandardSQL };

export const setRunMark = StateEffect.define();
const runMark = StateField.define({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) if (e.is(setRunMark)) v = e.value ? Decoration.set([Decoration.mark({ class: 'cm-ran' }).range(e.value.from, e.value.to)]) : Decoration.none;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * lang: 'pg' | 'mysql' | 'sqlite' | 'db2' | 'mongo'
 * schema: { tableName: [columns] } for completion
 */
export function createEditor({ parent, doc = '', lang = 'pg', readOnly = false, schema = {}, defaultSchema, onChange, keys = [], fontSize = 13 }) {
  const langComp = new Compartment();
  const roComp = new Compartment();
  const sizeComp = new Compartment();
  const langExt = (l, s, d) => (l === 'mongo' ? javascript() : sql({ dialect: DIALECTS[l] || StandardSQL, schema: s, defaultSchema: d, upperCaseKeywords: true }));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
        EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), autocompletion({ activateOnTyping: true, maxRenderedOptions: 60 }),
        rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
        syntaxHighlighting(style), runMark,
        keymap.of([...keys, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab, { key: 'Mod-/', run: toggleComment }]),
        langComp.of(langExt(lang, schema, defaultSchema)),
        roComp.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        sizeComp.of(EditorView.theme({ '&': { fontSize: fontSize + 'px' } })),
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(u.state.doc.toString()); }),
        EditorView.lineWrapping,
      ],
    }),
  });
  return {
    view,
    get text() { return view.state.doc.toString(); },
    set text(v) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }); },
    setLang(l, s = {}, d) { view.dispatch({ effects: langComp.reconfigure(langExt(l, s, d)) }); },
    setFontSize(n) { view.dispatch({ effects: sizeComp.reconfigure(EditorView.theme({ '&': { fontSize: n + 'px' } })) }); },
    selection() { const r = view.state.selection.main; return { from: r.from, to: r.to, text: view.state.sliceDoc(r.from, r.to), head: r.head }; },
    mark(from, to) { view.dispatch({ effects: setRunMark.of(from == null ? null : { from, to }) }); },
    focus() { view.focus(); },
    insert(text) { const r = view.state.selection.main; view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } }); view.focus(); },
    destroy() { view.destroy(); },
  };
}
/**
 * A one-line editor for the WHERE box above a table: SQL highlighting, and completion of the table's
 * columns (with their types), SQL keywords and functions. For MongoDB it completes field names and $operators.
 * columns: [{ name, type }]
 */
const MONGO_OPS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex', '$options', '$and', '$or', '$nor', '$not', '$elemMatch', '$size', '$all', '$type', '$expr'];
const WHERE_WORDS = ['AND', 'OR', 'NOT', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'NOT LIKE', 'BETWEEN', 'EXISTS', 'TRUE', 'FALSE', 'NULL', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];
const WHERE_FUNCS = { all: ['COALESCE', 'LOWER', 'UPPER', 'LENGTH', 'TRIM', 'SUBSTR', 'CAST', 'ROUND', 'ABS', 'NULLIF', 'REPLACE'], pg: ['ILIKE', 'NOT ILIKE', 'NOW', 'DATE_TRUNC', 'EXTRACT', 'AGE', 'TO_CHAR', 'ANY', 'SIMILAR TO'], mysql: ['NOW', 'DATE', 'YEAR', 'MONTH', 'DATE_FORMAT', 'DATEDIFF', 'CONCAT', 'REGEXP', 'JSON_EXTRACT'], sqlite: ['DATE', 'DATETIME', 'STRFTIME', 'JULIANDAY', 'GLOB', 'INSTR', 'JSON_EXTRACT'], db2: ['DATE', 'YEAR', 'MONTH', 'DAYS', 'CURRENT TIMESTAMP', 'VARCHAR_FORMAT', 'LOCATE'] };
export function createLineEditor({ parent, doc = '', lang = 'pg', placeholder = '', columns = [], recent = () => [], onEnter, onEscape, fontSize = 12.5 }) {
  const langComp = new Compartment();
  let cols = columns;
  const colSource = (ctx) => {
    const w = ctx.matchBefore(lang === 'mongo' ? /[\w$."]*$/ : /[\w"`$]*$/);
    if (!w || (w.from === w.to && !ctx.explicit)) return null;
    const word = w.text.replace(/^["`]/, '');
    if (lang === 'mongo' && word.startsWith('$')) return { from: w.from, options: MONGO_OPS.map((o) => ({ label: o, type: 'keyword' })), validFor: /^\$\w*$/ };
    const quoteNeeded = (n) => (lang === 'mongo' ? !/^[A-Za-z_$][\w$]*$/.test(n) : !(/^[a-z_][a-z0-9_]*$/.test(n) || (lang === 'db2' && /^[A-Z_][A-Z0-9_]*$/.test(n)) || (lang === 'mysql' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) || (lang === 'sqlite' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))));
    const q = (n) => (lang === 'mongo' ? JSON.stringify(n) : lang === 'mysql' ? '`' + n.replace(/`/g, '``') + '`' : '"' + n.replace(/"/g, '""') + '"');
    const options = cols.map((c, i) => ({ label: c.name, apply: quoteNeeded(c.name) ? q(c.name) : c.name, detail: c.type || '', type: c.pk ? 'constant' : 'property', boost: 50 - Math.min(i, 49) }));
    if (lang !== 'mongo') {
      options.push(...WHERE_WORDS.map((k) => ({ label: k, type: 'keyword', boost: -10 })));
      options.push(...[...WHERE_FUNCS.all, ...(WHERE_FUNCS[lang] || [])].map((k) => ({ label: k, apply: /^[A-Z_]+$/.test(k) && !['ILIKE', 'ANY', 'REGEXP', 'GLOB', 'CURRENT_DATE'].includes(k) ? k + '(' : k, type: 'function', boost: -20 })));
    }
    return { from: w.from, options, validFor: /^["`]?[\w$]*$/ };
  };
  const histSource = (ctx) => {
    if (ctx.state.doc.length) return null; // only for an empty box: pick a filter used before
    const list = recent();
    if (!list.length) return null;
    return { from: 0, to: 0, options: list.map((h, i) => ({ label: h, type: 'text', detail: 'recent', boost: 99 - i })), filter: false };
  };
  const langExt = () => (lang === 'mongo' ? javascript() : [sql({ dialect: DIALECTS[lang] || StandardSQL, upperCaseKeywords: true })]);
  const enter = (v) => { if (completionStatus(v.state) === 'active') return false; onEnter?.(v.state.doc.toString()); return true; };
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(), drawSelection(), closeBrackets(), syntaxHighlighting(style), highlightSpecialChars(),
        autocompletion({ override: [colSource, histSource], activateOnTyping: true, maxRenderedOptions: 80, icons: true }),
        Prec.highest(keymap.of([
          { key: 'Enter', run: enter },
          { key: 'Escape', run: (v) => { if (completionStatus(v.state) === 'active') return false; onEscape?.(); return true; } },
          { key: 'ArrowDown', run: (v) => { if (completionStatus(v.state)) return false; startCompletion(v); return true; } },
        ])),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap.filter((b) => !['Enter', 'Mod-Enter', 'Shift-Enter'].includes(b.key))]),
        EditorState.transactionFilter.of((tr) => (tr.docChanged && tr.newDoc.lines > 1 ? [tr, { changes: { from: 0, to: tr.newDoc.length, insert: tr.newDoc.toString().replace(/\s*\n\s*/g, ' ') }, sequential: true }] : tr)),
        cmPlaceholder(placeholder),
        langComp.of(langExt()),
        EditorView.theme({ '&': { fontSize: fontSize + 'px' } }),
        EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      ],
    }),
  });
  view.dom.classList.add('cm-line-editor');
  view.dom.addEventListener('focusin', () => { if (!view.state.doc.length) setTimeout(() => startCompletion(view), 0); });
  return {
    view,
    get value() { return view.state.doc.toString(); },
    set value(v) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v || '' }, selection: { anchor: (v || '').length } }); },
    setColumns(c) { cols = c || []; },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
}
export { ViewPlugin };
