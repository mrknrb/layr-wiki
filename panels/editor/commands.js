// The editor's commands (`ed.exec(name, arg)`, the toolbar, the slash menu, the keyboard): the pure text operations of
// markdown-ops.js applied to the view, plus Enter/Backspace/Tab in lists and the search panel.
import {
  EditorSelection, indentLess, indentMore, indentUnit, insertTab, openSearchPanel, redo, startCompletion,
  syntaxTree, undo,
} from "../../vendor/editor.js";
import {
  backspaceMarker, codeBlock, continueList, insertBlock, insertCallout, mathBlock, newTable, setColor, setHeading,
  setHighlight, toggleFormat, toggleLines, toggleLink, toggleTask,
} from "./markdown-ops.js";

/** Run a pure operation `(text, from, to) → edit|null` on the main selection. */
export function applyOp(view, op, userEvent = "input.format") {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const result = op(view.state.doc.toString(), from, to);
  if (!result) return false;
  view.dispatch({
    changes: result.changes,
    selection: EditorSelection.single(result.anchor, result.head),
    scrollIntoView: true,
    userEvent,
  });
  return true;
}

/** Is the cursor inside code (a fenced block, inline code, the properties block)? Lists and marks don't apply there. */
export function inCode(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (/^(FencedCode|CodeBlock|InlineCode|Frontmatter|BlockMath)$/.test(node.name)) return true;
  }
  return false;
}

/** Insert text at the selection (replacing it), the cursor after it. */
export function insertText(view, text, userEvent = "input") {
  if (view.state.readOnly) return false;
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent });
  return true;
}

function openReplace(view) {
  openSearchPanel(view);
  requestAnimationFrame(() => {
    const input = view.dom.querySelector(".cm-search input[name=replace]");
    if (!input) return;
    input.focus();
    input.select();
  });
  return true;
}

/** Every command `exec` knows: name → (view, arg) → bool. `ctx` gives settings, uploads and the page. */
export function commandTable(ctx) {
  const fmt = (name) => (view) => applyOp(view, (t, a, b) => toggleFormat(t, a, b, name));
  return {
    bold: fmt("bold"),
    italic: fmt("italic"),
    strike: fmt("strike"),
    underline: fmt("underline"),
    sup: fmt("sup"),
    sub: fmt("sub"),
    code: fmt("code"),
    highlight: (view, color) => applyOp(view, (t, a, b) => setHighlight(t, a, b, color)),
    color: (view, color) => applyOp(view, (t, a, b) => setColor(t, a, b, color ?? null)),
    link: (view, url) => {
      const ok = applyOp(view, (t, a, b) => toggleLink(t, a, b, url || null));
      const { head } = view.state.selection.main;
      if (ok && !url && view.state.sliceDoc(head - 2, head + 2) === "[[]]") startCompletion(view);
      return ok;
    },
    heading: (view, n) => applyOp(view, (t, a, b) => setHeading(t, a, b, Number(n) || 0)),
    paragraph: (view) => applyOp(view, (t, a, b) => setHeading(t, a, b, 0)),
    bullet: (view) => applyOp(view, (t, a, b) => toggleLines(t, a, b, "bullet")),
    numbered: (view) => applyOp(view, (t, a, b) => toggleLines(t, a, b, "numbered")),
    task: (view) => applyOp(view, (t, a, b) => toggleLines(t, a, b, "task")),
    toggleTask: (view) => applyOp(view, toggleTask),
    quote: (view) => applyOp(view, (t, a, b) => toggleLines(t, a, b, "quote")),
    callout: (view, kind) => applyOp(view, (t, a, b) => insertCallout(t, a, b, kind || "note")),
    table: (view, size) => {
      const [c, r] = Array.isArray(size) ? size : [3, 2];
      const md = newTable(c, r);
      return applyOp(view, (t, a) => insertBlock(t, a, md, 2), "input.table");
    },
    hr: (view) => applyOp(view, (t, a) => insertBlock(t, a, "---", 3)),
    codeblock: (view, lang) => applyOp(view, (t, a, b) => codeBlock(t, a, b, lang ?? "")),
    math: (view) => applyOp(view, mathBlock),
    image: (view) => ctx.pickAndUpload(view),
    embed: (view) => {
      insertText(view, "![[]]");
      const { head } = view.state.selection.main;
      view.dispatch({ selection: { anchor: head - 2 } });
      startCompletion(view);
      return true;
    },
    indent: (view) => indentMore(view),
    outdent: (view) => indentLess(view),
    undo: (view) => undo(view),
    redo: (view) => redo(view),
    find: (view) => openSearchPanel(view),
    replace: (view) => openReplace(view),
  };
}

// ---------- Enter, Backspace and Tab in lists ----------

/** Enter continues a list, a checklist or a quote (setting "Smart lists"). */
export function smartEnter(ctx) {
  return (view) => {
    if (!ctx.setting("smartLists") || view.state.readOnly) return false;
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty || inCode(state, sel.head)) return false;
    const line = state.doc.lineAt(sel.head);
    const r = continueList(line.text, sel.head - line.from, state.facet(indentUnit));
    if (!r) return false;
    view.dispatch({
      changes: { from: line.from + r.from, to: line.from + r.to, insert: r.insert },
      selection: { anchor: line.from + r.cursor },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  };
}

/** Backspace right after a list marker or `>` removes the marker. */
export function smartBackspace(ctx) {
  return (view) => {
    if (!ctx.setting("smartLists") || view.state.readOnly) return false;
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty || inCode(state, sel.head)) return false;
    const line = state.doc.lineAt(sel.head);
    const r = backspaceMarker(line.text, sel.head - line.from);
    if (!r) return false;
    view.dispatch({ changes: { from: line.from + r.from, to: line.from + r.to }, userEvent: "delete.backward" });
    return true;
  };
}

const LIST_LINE = /^\s*([-*+]|\d{1,9}[.)])\s|^\s*>/;
/** Tab indents list items (and any selection of lines); elsewhere it types a tab (in code: the indent unit). */
export const smartTab = (view) => {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  if (!sel.empty && state.doc.lineAt(sel.from).number !== state.doc.lineAt(sel.to).number) return indentMore(view);
  if (LIST_LINE.test(line.text)) return indentMore(view);
  if (inCode(state, sel.head)) return insertText(view, state.facet(indentUnit));
  return insertTab(view);
};
export const smartShiftTab = (view) => indentLess(view);

/** The keyboard shortcuts (the shell's own hotkeys don't reach a focused editor for these keys). */
export function editorKeymap(ctx, run) {
  const k = (key, cmd, arg) => ({ key, run: (view) => run(view, cmd, arg) !== false, preventDefault: true });
  return [
    k("Mod-b", "bold"),
    k("Mod-i", "italic"),
    k("Mod-u", "underline"),
    k("Mod-Shift-x", "strike"),
    k("Mod-Shift-h", "highlight"),
    k("Mod-`", "code"),
    k("Mod-k", "link"),
    ...[1, 2, 3, 4, 5, 6].map((n) => k(`Mod-${n}`, "heading", n)),
    k("Mod-0", "paragraph"),
    k("Mod-Enter", "toggleTask"),
    k("Mod-Shift-7", "numbered"),
    k("Mod-Shift-8", "bullet"),
    k("Mod-Shift-9", "task"),
    k("Mod-f", "find"),
    k("Mod-h", "replace"),
    { key: "Mod-s", run: () => (ctx.onSave?.(), true), preventDefault: true },
    { key: "Enter", run: smartEnter(ctx) },
    { key: "Backspace", run: smartBackspace(ctx) },
    { key: "Tab", run: smartTab, shift: smartShiftTab },
  ];
}
