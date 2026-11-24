// CodeMirror 6 set up for SQL (per dialect) and MongoDB shell JavaScript.
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldGutter } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
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
export { ViewPlugin };
