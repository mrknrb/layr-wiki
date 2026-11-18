// The editor's text operations as pure functions on a string and a selection, so they can be tested without a browser
// (test/editor.test.js): formatting toggles, colours, headings, lists, callouts, list continuation, tables, image
// sizes, word counts, fuzzy matching. No imports from the CodeMirror bundle here.
//
// An edit is `{changes: [{from, to, insert}], anchor, head}`: changes in the old text's positions (sorted, not
// overlapping), the selection in the new text's positions. `applyEdit(text, edit)` gives the new text.

/** The new text after an edit. */
export function applyEdit(text, edit) {
  let out = "";
  let last = 0;
  for (const c of [...edit.changes].sort((a, b) => a.from - b.from)) {
    out += text.slice(last, c.from) + c.insert;
    last = c.to;
  }
  return out + text.slice(last);
}

/** A position in the old text → the new text (insertions at the position push it forward unless `assoc` < 0). */
export function mapPos(pos, changes, assoc = 1) {
  let delta = 0;
  for (const c of [...changes].sort((a, b) => a.from - b.from)) {
    if (c.from > pos || (c.from === pos && c.to === pos && assoc < 0)) break;
    if (pos < c.to) return c.from + delta + (assoc < 0 ? 0 : c.insert.length);
    delta += c.insert.length - (c.to - c.from);
  }
  return pos + delta;
}

const edit = (changes, anchor, head = anchor) => ({ changes, anchor, head });

// ---------- inline formatting ----------

/** The formats `toggleFormat` knows: their opening and closing marks. */
export const FORMATS = {
  bold: { open: "**", close: "**", re: /\*\*(?=\S)(.*?\S)\*\*/g },
  italic: { open: "*", close: "*", re: /(?<![*\\])\*(?![*\s])(.*?[^*\s])\*(?!\*)/g },
  strike: { open: "~~", close: "~~", re: /~~(?=\S)(.*?\S)~~/g },
  highlight: { open: "==", close: "==", re: /==(?=\S)(.*?\S)==/g },
  code: { open: "`", close: "`", re: /`([^`\n]+)`/g },
  math: { open: "$", close: "$", re: /(?<![$\\])\$(?=\S)([^$\n]*?\S)\$(?!\$)/g },
  underline: { open: "<u>", close: "</u>", re: /<u>(.*?)<\/u>/g },
  sup: { open: "<sup>", close: "</sup>", re: /<sup>(.*?)<\/sup>/g },
  sub: { open: "<sub>", close: "</sub>", re: /<sub>(.*?)<\/sub>/g },
};

/** The line around `pos`: `{from, to, text}`. */
export function lineAt(text, pos) {
  const from = text.lastIndexOf("\n", pos - 1) + 1;
  let to = text.indexOf("\n", pos);
  if (to < 0) to = text.length;
  return { from, to, text: text.slice(from, to) };
}

/** The word around `pos` (letters, digits, `_`, `'`, `-` inside), or null when `pos` isn't in or at a word. */
export function wordAt(text, pos) {
  const w = /[\p{L}\p{N}_'’-]/u;
  let from = pos;
  let to = pos;
  while (from > 0 && w.test(text[from - 1])) from--;
  while (to < text.length && w.test(text[to])) to++;
  return from < to ? { from, to } : null;
}

/** A pattern's match on the line around [from, to] whose inner text holds the selection: positions, or null. */
function enclosing(text, from, to, re, innerGroup = 1) {
  const line = lineAt(text, from);
  if (to > line.to) return null;
  const flags = [...new Set(`${re.flags}gd`)].join("");
  for (const m of line.text.matchAll(new RegExp(re.source, flags))) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    const innerStart = line.from + m.indices[innerGroup][0];
    const innerEnd = line.from + m.indices[innerGroup][1];
    if (innerStart <= from && to <= innerEnd) return { start, end, innerStart, innerEnd, match: m };
  }
  return null;
}

/** Remove the marks around a match found by `enclosing`, keeping the selection on the same characters. */
function unwrap(enc, from, to) {
  const changes = [
    { from: enc.start, to: enc.innerStart, insert: "" },
    { from: enc.innerEnd, to: enc.end, insert: "" },
  ];
  return edit(changes, mapPos(from, changes, -1), mapPos(to, changes, -1));
}

/** Wrap [from, to] in `open`/`close`; an empty selection takes the word around it, or puts the cursor between. */
function wrap(text, from, to, open, close) {
  if (from === to) {
    const w = wordAt(text, from);
    if (!w) return edit([{ from, to, insert: open + close }], from + open.length);
    const changes = [{ from: w.from, to: w.from, insert: open }, { from: w.to, to: w.to, insert: close }];
    return edit(changes, from + open.length);
  }
  // Spaces at the ends stay outside the marks ("**word **" is not bold in Markdown).
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  const changes = [{ from, to: from, insert: open }, { from: to, to, insert: close }];
  return edit(changes, from + open.length, to + open.length);
}

/**
 * Bold, italic, strike, highlight, code, math, underline, sup, sub on [from, to]: removes the marks when the selection
 * is already formatted that way (selected with its marks, just inside them, or anywhere inside on the same line),
 * else adds them.
 */
export function toggleFormat(text, from, to, name) {
  const f = FORMATS[name];
  if (!f) throw new Error(`No format ${name}`);
  const sel = text.slice(from, to);
  const re = new RegExp(`^${f.re.source}$`, f.re.flags.replace("g", ""));
  if (sel && re.test(sel)) {
    const changes = [{ from, to: from + f.open.length, insert: "" }, { from: to - f.close.length, to, insert: "" }];
    return edit(changes, from, to - f.open.length - f.close.length);
  }
  const enc = enclosing(text, from, to, f.re);
  if (enc) return unwrap(enc, from, to);
  return wrap(text, from, to, f.open, f.close);
}

/** Which inline formats hold the selection (for the toolbar's pressed buttons). */
export function activeFormats(text, from, to) {
  const out = new Set();
  for (const [name, f] of Object.entries(FORMATS)) if (enclosing(text, from, to, f.re)) out.add(name);
  if (enclosing(text, from, to, COLOR_SPAN, 2)) out.add("color");
  if (enclosing(text, from, to, MARK_SPAN, 2)) out.add("highlight");
  return out;
}

// ---------- colours (the only raw HTML the wiki keeps; see docs/PLAN.md) ----------

const COLOR_WORDS = /^[a-z]{3,30}$/i;
/** A colour value the wiki keeps in a style (`#hex`, `rgb()`/`rgba()`, `var(--name)`, a CSS colour word), else null. */
export function safeColor(value) {
  const v = String(value ?? "").trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)$/i.test(v)) return v;
  if (/^rgba?\(\s*[\d.]+%?\s+[\d.]+%?\s+[\d.]+%?\s*(\/\s*[\d.]+%?\s*)?\)$/i.test(v)) return v;
  if (/^var\(--[\w-]+\)$/.test(v)) return v;
  if (COLOR_WORDS.test(v)) return v.toLowerCase();
  return null;
}

const COLOR_SPAN = /<span style="color:\s*([^";]+);?\s*">(.*?)<\/span>/g;
const MARK_SPAN = /<mark style="background(?:-color)?:\s*([^";]+);?\s*">(.*?)<\/mark>/g;

/** The selection's text with every colour span (or coloured mark) inside it taken out, keeping the text. */
function stripInside(text, from, to, re) {
  const changes = [];
  const part = text.slice(from, to);
  for (const m of part.matchAll(new RegExp(re.source, "g"))) {
    const start = from + m.index;
    const open = m[0].indexOf(">") + 1;
    changes.push({ from: start, to: start + open, insert: "" });
    const closeLen = m[0].length - m[0].lastIndexOf("</");
    changes.push({ from: start + m[0].length - closeLen, to: start + m[0].length, insert: "" });
  }
  return changes;
}

/** Text colour: `<span style="color:…">`; `color` null removes it. Gives null when there is nothing to do. */
export function setColor(text, from, to, color) {
  const c = color === null ? null : safeColor(color);
  if (color !== null && !c) throw new Error(`Not a colour: ${color}`);
  const enc = enclosing(text, from, to, COLOR_SPAN, 2);
  if (enc) {
    if (c === null) return unwrap(enc, from, to);
    const valueStart = enc.start + enc.match[0].indexOf(enc.match[1]);
    const changes = [{ from: valueStart, to: valueStart + enc.match[1].length, insert: c }];
    return edit(changes, mapPos(from, changes), mapPos(to, changes));
  }
  const inner = stripInside(text, from, to, COLOR_SPAN);
  if (c === null) return inner.length ? edit(inner, mapPos(from, inner, -1), mapPos(to, inner, -1)) : null;
  const base = applyEdit(text, edit(inner, 0));
  const w = wrap(base, mapPos(from, inner, -1), mapPos(to, inner, -1), `<span style="color:${c}">`, "</span>");
  return composeEdits(text, inner, w);
}

/**
 * Highlight: no colour (undefined or "") toggles `==text==`; a colour makes `<mark style="background:…">` (or changes
 * the colour of the highlight around the selection); null removes either kind.
 */
export function setHighlight(text, from, to, color) {
  const c = color ? safeColor(color) : null;
  if (color && !c) throw new Error(`Not a colour: ${color}`);
  const plain = enclosing(text, from, to, FORMATS.highlight.re);
  const marked = enclosing(text, from, to, MARK_SPAN, 2);
  if (color === null) {
    if (marked) return unwrap(marked, from, to);
    if (plain) return unwrap(plain, from, to);
    const inner = stripInside(text, from, to, MARK_SPAN);
    return inner.length ? edit(inner, mapPos(from, inner, -1), mapPos(to, inner, -1)) : null;
  }
  if (!c) {
    if (marked) return unwrap(marked, from, to);
    return toggleFormat(text, from, to, "highlight");
  }
  if (marked) {
    const valueStart = marked.start + marked.match[0].indexOf(marked.match[1]);
    const changes = [{ from: valueStart, to: valueStart + marked.match[1].length, insert: c }];
    return edit(changes, mapPos(from, changes), mapPos(to, changes));
  }
  if (plain) {
    const changes = [
      { from: plain.start, to: plain.innerStart, insert: `<mark style="background:${c}">` },
      { from: plain.innerEnd, to: plain.end, insert: "</mark>" },
    ];
    return edit(changes, mapPos(from, changes), mapPos(to, changes, -1));
  }
  const inner = stripInside(text, from, to, MARK_SPAN);
  const base = applyEdit(text, edit(inner, 0));
  const w = wrap(base, mapPos(from, inner, -1), mapPos(to, inner, -1), `<mark style="background:${c}">`, "</mark>");
  return composeEdits(text, inner, w);
}

/** Two edits in a row as one, as a single change of the touched range (good enough for a selection's line). */
function composeEdits(text, first, second) {
  if (!first.length) return second;
  const mid = applyEdit(text, edit(first, 0));
  const out = applyEdit(mid, second);
  let a = 0;
  while (a < text.length && a < out.length && text[a] === out[a]) a++;
  let b = 0;
  while (b < text.length - a && b < out.length - a && text[text.length - 1 - b] === out[out.length - 1 - b]) b++;
  return edit([{ from: a, to: text.length - b, insert: out.slice(a, out.length - b) }], second.anchor, second.head);
}

/** Every inline HTML pair the wiki keeps on a line: `{tag, from, openEnd, closeStart, to, color?, background?}`. */
export function htmlSpans(line) {
  const out = [];
  const stack = [];
  for (const m of line.matchAll(/<(\/?)(u|sup|sub|mark|span)(?:\s+style="([^"<>]*)")?\s*>/gi)) {
    const tag = m[2].toLowerCase();
    if (!m[1]) {
      stack.push({ tag, from: m.index, openEnd: m.index + m[0].length, style: m[3] ?? "" });
      continue;
    }
    const i = stack.map((s) => s.tag).lastIndexOf(tag);
    if (i < 0) continue;
    const open = stack.splice(i)[0];
    const span = { tag, from: open.from, openEnd: open.openEnd, closeStart: m.index, to: m.index + m[0].length };
    for (const decl of open.style.split(";")) {
      const [k, ...v] = decl.split(":");
      const key = k?.trim().toLowerCase();
      const value = safeColor(v.join(":"));
      if (!value) continue;
      if (key === "color" && tag === "span") span.color = value;
      if ((key === "background" || key === "background-color") && (tag === "mark" || tag === "span")) {
        span.background = value;
      }
    }
    if (tag === "span" && !span.color && !span.background) continue;
    out.push(span);
  }
  return out.sort((a, b) => a.from - b.from);
}

// ---------- line formats ----------

/** The lines [from, to] touches: `[{from, to, text}]`. */
export function linesIn(text, from, to) {
  const out = [];
  let line = lineAt(text, from);
  for (;;) {
    out.push(line);
    if (line.to >= to || line.to >= text.length) break;
    line = lineAt(text, line.to + 1);
  }
  return out;
}

const HEADING = /^(#{1,6})[ \t]+/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;

/** Heading level `n` (1-6) on the selected lines; the same level again, or 0, makes them plain text. */
export function setHeading(text, from, to, n) {
  const lines = linesIn(text, from, to);
  const same = lines.every((l) => HEADING.exec(l.text)?.[1].length === n);
  const changes = lines.map((l) => {
    const old = HEADING.exec(l.text)?.[0] ?? "";
    return { from: l.from, to: l.from + old.length, insert: same || !n ? "" : `${"#".repeat(n)} ` };
  }).filter((c) => c.to > c.from || c.insert);
  return edit(changes, mapPos(from, changes), mapPos(to, changes));
}

/** The heading level of the line at `pos` (0: not a heading). */
export const headingLevel = (text, pos) => HEADING.exec(lineAt(text, pos).text)?.[1].length ?? 0;

/**
 * Bullet, numbered, task or quote on the selected lines: removes it when every (non-empty) line has it already, else
 * sets it (replacing another list marker).
 */
export function toggleLines(text, from, to, kind) {
  let lines = linesIn(text, from, to);
  if (lines.length > 1) lines = lines.filter((l) => l.text.trim());
  const info = lines.map((l) => {
    const m = LIST.exec(l.text);
    return { line: l, m, indent: m ? m[1] : /^\s*/.exec(l.text)[0], marker: m?.[0] ?? null };
  });
  let changes;
  if (kind === "quote") {
    const all = lines.every((l) => /^\s*>/.test(l.text));
    changes = lines.map((l) => {
      if (all) {
        const m = /^(\s*)> ?/.exec(l.text);
        return { from: l.from + m[1].length, to: l.from + m[0].length, insert: "" };
      }
      return { from: l.from, to: l.from, insert: "> " };
    });
  } else {
    const has = (x) => {
      if (!x.m) return false;
      if (kind === "task") return Boolean(x.m[4]);
      if (kind === "numbered") return /\d/.test(x.m[2]) && !x.m[4];
      return !/\d/.test(x.m[2]) && !x.m[4];
    };
    const all = info.every(has);
    let n = 0;
    changes = info.map((x) => {
      const start = x.line.from + x.indent.length;
      const end = x.line.from + (x.marker ? x.marker.length : x.indent.length);
      let insert = "";
      if (!all) insert = kind === "task" ? "- [ ] " : kind === "numbered" ? `${++n}. ` : "- ";
      return { from: start, to: end, insert };
    });
  }
  changes = changes.filter((c) => c.to > c.from || c.insert);
  return edit(changes, mapPos(from, changes), mapPos(to, changes));
}

/** Ctrl+Enter: a task's box ticked or unticked; a list item or a plain line becomes an open task. */
export function toggleTask(text, from, to) {
  const lines = linesIn(text, from, to).filter((l, i, all) => all.length === 1 || l.text.trim());
  const changes = lines.map((l) => {
    const m = LIST.exec(l.text);
    if (m?.[4]) {
      const box = l.from + m[1].length + m[2].length + m[3].length + 1;
      return { from: box, to: box + 1, insert: m[4][1] === " " ? "x" : " " };
    }
    if (m) {
      const at = l.from + m[0].length;
      return { from: at, to: at, insert: "[ ] " };
    }
    const indent = /^\s*/.exec(l.text)[0].length;
    return { from: l.from + indent, to: l.from + indent, insert: "- [ ] " };
  });
  return edit(changes, mapPos(from, changes), mapPos(to, changes));
}

/** The task box's state at a position: true (done), false (open), or null (not a task line). */
export function taskState(text, pos) {
  const m = LIST.exec(lineAt(text, pos).text);
  return m?.[4] ? m[4][1] !== " " : null;
}

export const CALLOUTS = ["note", "info", "tip", "success", "question", "warning", "failure", "danger", "bug", "example",
  "quote", "abstract", "todo"];

/** A callout of `kind` around the selected lines; on a callout's first line, changes its kind instead. */
export function insertCallout(text, from, to, kind = "note") {
  const first = lineAt(text, from);
  const m = /^(\s*>\s*\[!)([\w-]+)(\])/.exec(first.text);
  if (m) {
    const changes = [{ from: first.from + m[1].length, to: first.from + m[1].length + m[2].length, insert: kind }];
    return edit(changes, mapPos(from, changes), mapPos(to, changes));
  }
  const lines = linesIn(text, from, to);
  const head = `> [!${kind}]`;
  if (lines.length === 1 && !lines[0].text.trim()) {
    const insert = `${head}\n> `;
    return edit([{ from: lines[0].from, to: lines[0].to, insert }], lines[0].from + insert.length);
  }
  const changes = [{ from: lines[0].from, to: lines[0].from, insert: `${head}\n` }];
  for (const l of lines) changes.push({ from: l.from, to: l.from, insert: "> " });
  // Both inserts at the first line's start: the callout's head goes first.
  changes.sort((a, b) => a.from - b.from || (a.insert.startsWith("> [!") ? -1 : 1));
  const merged = [];
  for (const c of changes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.from === c.from && prev.to === c.to && prev.to === c.from) prev.insert += c.insert;
    else merged.push({ ...c });
  }
  const end = lines[lines.length - 1].to;
  return edit(merged, mapPos(end, merged));
}

/**
 * A block (`text` of whole lines) on its own lines at `pos`: after the current line when it holds text, else in its
 * place. `cursor` is where the cursor goes inside the block.
 */
export function insertBlock(doc, pos, block, cursor = block.length) {
  const line = lineAt(doc, pos);
  if (!line.text.trim()) {
    const after = line.to < doc.length && doc[line.to + 1] !== "\n" && lineAt(doc, line.to + 1).text.trim() ? "\n" : "";
    return edit([{ from: line.from, to: line.to, insert: block + after }], line.from + cursor);
  }
  const insert = `\n${block}`;
  const next = line.to < doc.length ? lineAt(doc, line.to + 1) : null;
  const tail = next && next.text.trim() ? "\n" : "";
  return edit([{ from: line.to, to: line.to, insert: insert + tail }], line.to + 1 + cursor);
}

/** A fenced code block around the selected lines, or an empty one with the cursor inside. */
export function codeBlock(text, from, to, lang = "") {
  const fence = "```";
  if (from !== to) {
    const lines = linesIn(text, from, to);
    const a = lines[0].from;
    const b = lines[lines.length - 1].to;
    const insert = `${fence}${lang}\n${text.slice(a, b)}\n${fence}`;
    return edit([{ from: a, to: b, insert }], a + fence.length + lang.length + 1, a + insert.length - fence.length - 1);
  }
  const block = `${fence}${lang}\n\n${fence}`;
  return insertBlock(text, from, block, fence.length + lang.length + 1);
}

/** Math: `$…$` around a selection on one line, else a `$$` block. */
export function mathBlock(text, from, to) {
  if (from !== to && lineAt(text, from).to >= to) return toggleFormat(text, from, to, "math");
  if (from !== to) {
    const lines = linesIn(text, from, to);
    const a = lines[0].from;
    const b = lines[lines.length - 1].to;
    return edit([{ from: a, to: b, insert: `$$\n${text.slice(a, b)}\n$$` }], a + 3);
  }
  return insertBlock(text, from, "$$\n\n$$", 3);
}

/** A link: a URL selected → `[](url)`, other text → `[[text]]`, inside a `[[link]]` → its text again. */
export function toggleLink(text, from, to, url = null) {
  const enc = enclosing(text, from, to, /(?<!!)\[\[([^\[\]\n]+)\]\]/g);
  if (enc && !url) {
    const inner = enc.match[1];
    const label = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner;
    const changes = [{ from: enc.start, to: enc.end, insert: label }];
    return edit(changes, enc.start, enc.start + label.length);
  }
  const sel = text.slice(from, to);
  if (url) {
    const insert = `[${sel}](${url})`;
    return edit([{ from, to, insert }], from + 1, from + 1 + sel.length);
  }
  if (/^(https?:\/\/|mailto:)\S+$/i.test(sel)) {
    return edit([{ from, to, insert: `[](${sel})` }], from + 1);
  }
  if (!sel) return edit([{ from, to, insert: "[[]]" }], from + 2);
  return edit([{ from, to, insert: `[[${sel}]]` }], from + 2, from + 2 + sel.length);
}

// ---------- Enter and Backspace in lists ----------

const QUOTE_PREFIX = /^(\s*(?:>[ \t]?)+)/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;

/** A list or quote line's parts: `{quote, indent, marker, number, delim, space, task, end}` (end: where text starts). */
export function listPrefix(line) {
  const quote = QUOTE_PREFIX.exec(line)?.[1] ?? "";
  const m = ITEM.exec(line.slice(quote.length));
  if (!quote && !m) return null;
  if (!m) return { quote, indent: "", marker: null, end: quote.length };
  return {
    quote, indent: m[1], marker: m[2], number: m[3] ? Number(m[3]) : null, delim: m[4] ?? null, space: m[5],
    task: m[6] ?? null, end: quote.length + m[0].length,
  };
}

/**
 * Enter in a list or quote line at column `col`: `{from, to, insert, cursor}` (relative to the line start), or null
 * for a plain new line. A non-empty item continues the list (the next number, an open box); an empty one ends the list
 * (or moves out one level when nested); an empty quote line ends the quote.
 */
export function continueList(line, col, indentUnit = "    ") {
  const p = listPrefix(line);
  if (!p || col < p.end) return null;
  const empty = !line.slice(p.end).trim();
  if (empty) {
    if (p.marker && p.indent.length) {
      const indent = p.indent.slice(Math.min(p.indent.length, indentUnit.length));
      const kept = `${p.quote}${indent}${line.slice(p.quote.length + p.indent.length, p.end)}`;
      return { from: 0, to: line.length, insert: kept, cursor: kept.length };
    }
    const kept = p.marker ? p.quote : p.quote.replace(/>[ \t]?$/, "").replace(/\s+$/, "");
    return { from: 0, to: line.length, insert: kept, cursor: kept.length };
  }
  let next = p.quote;
  if (p.marker) {
    const marker = p.number !== null ? `${p.number + 1}${p.delim}` : p.marker;
    next += `${p.indent}${marker}${p.space.includes("\t") ? p.space : " "}${p.task ? "[ ] " : ""}`;
  }
  // Spaces before the cursor would trail on the old line: they go.
  let from = col;
  while (from > p.end && /[ \t]/.test(line[from - 1])) from--;
  return { from, to: col, insert: `\n${next}`, cursor: from + 1 + next.length };
}

/**
 * Backspace right after a list marker or a quote's `>`: `{from, to}` to delete (relative to the line start), or null.
 * A task's box goes first, then the marker; a quote's `>` one level at a time.
 */
export function backspaceMarker(line, col) {
  const p = listPrefix(line);
  if (!p || col !== p.end) return null;
  if (p.marker && p.task) return { from: p.end - p.task.length, to: p.end };
  if (p.marker) return { from: p.quote.length + p.indent.length, to: p.end };
  const m = /(>[ \t]?)$/.exec(p.quote);
  return m ? { from: p.end - m[1].length, to: p.end } : null;
}

// ---------- tables ----------

/** One table row's cells (`\|` stays a `|` inside a cell). */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A Markdown table → `{header: [], align: ["left"|"center"|"right"|null], rows: [[]]}`, or null. */
export function parseTable(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2 || !SEP.test(lines[1]) || !lines[0].includes("|")) return null;
  const header = splitRow(lines[0]);
  const align = splitRow(lines[1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null);
  while (align.length < header.length) align.push(null);
  align.length = header.length;
  const rows = lines.slice(2).map((l) => {
    const cells = splitRow(l);
    while (cells.length < header.length) cells.push("");
    return cells.slice(0, header.length);
  });
  return { header, align, rows };
}

const cellText = (c) => String(c ?? "").replace(/\n/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();
const width = (s) => [...s].length;

/** A table back to Markdown, columns padded to line up. */
export function serializeTable(t) {
  const cols = t.header.length;
  const all = [t.header, ...t.rows].map((r) => Array.from({ length: cols }, (_x, i) => cellText(r[i])));
  const w = Array.from({ length: cols }, (_x, i) => Math.max(3, ...all.map((r) => width(r[i]))));
  const pad = (s, i) => {
    const gap = w[i] - width(s);
    if (t.align[i] === "right") return " ".repeat(gap) + s;
    if (t.align[i] === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
    return s + " ".repeat(gap);
  };
  const row = (r) => `| ${r.map(pad).join(" | ")} |`;
  const sep = w.map((n, i) => {
    const a = t.align[i];
    const dashes = "-".repeat(Math.max(1, n - (a === "center" ? 2 : a ? 1 : 0)));
    return a === "center" ? `:${dashes}:` : a === "left" ? `:${dashes}` : a === "right" ? `${dashes}:` : dashes;
  });
  return [row(all[0]), `| ${sep.join(" | ")} |`, ...all.slice(1).map(row)].join("\n");
}

const clone = (t) => ({ header: [...t.header], align: [...t.align], rows: t.rows.map((r) => [...r]) });

/** Table edits (all give a new table). `row` -1 is the header; rows are counted in the body. */
export const tableOps = {
  setCell(t, row, col, text) {
    const n = clone(t);
    if (row < 0) n.header[col] = text;
    else n.rows[row][col] = text;
    return n;
  },
  insertRow(t, at) {
    const n = clone(t);
    n.rows.splice(Math.max(0, Math.min(at, n.rows.length)), 0, n.header.map(() => ""));
    return n;
  },
  deleteRow(t, at) {
    const n = clone(t);
    if (at >= 0 && at < n.rows.length) n.rows.splice(at, 1);
    return n;
  },
  moveRow(t, at, by) {
    const n = clone(t);
    const to = at + by;
    if (at < 0 || to < 0 || at >= n.rows.length || to >= n.rows.length) return n;
    const [r] = n.rows.splice(at, 1);
    n.rows.splice(to, 0, r);
    return n;
  },
  insertCol(t, at, name = "") {
    const n = clone(t);
    const i = Math.max(0, Math.min(at, n.header.length));
    n.header.splice(i, 0, name);
    n.align.splice(i, 0, null);
    for (const r of n.rows) r.splice(i, 0, "");
    return n;
  },
  deleteCol(t, at) {
    const n = clone(t);
    if (n.header.length <= 1 || at < 0 || at >= n.header.length) return n;
    n.header.splice(at, 1);
    n.align.splice(at, 1);
    for (const r of n.rows) r.splice(at, 1);
    return n;
  },
  moveCol(t, at, by) {
    const n = clone(t);
    const to = at + by;
    if (at < 0 || to < 0 || at >= n.header.length || to >= n.header.length) return n;
    for (const arr of [n.header, n.align, ...n.rows]) {
      const [x] = arr.splice(at, 1);
      arr.splice(to, 0, x);
    }
    return n;
  },
  setAlign(t, col, align) {
    const n = clone(t);
    n.align[col] = align || null;
    return n;
  },
};

/** A new table's Markdown: `cols` columns, `rows` empty body rows. */
export const newTable = (cols = 3, rows = 2) =>
  serializeTable({
    header: Array.from({ length: cols }, (_x, i) => `Column ${i + 1}`),
    align: Array(cols).fill(null),
    rows: Array.from({ length: rows }, () => Array(cols).fill("")),
  });

// ---------- embeds ----------

const SIZE = /^\d{1,5}(x\d{1,5})?$/;

/** An embed's inside (`pic.png|A caption|400`) → `{target, heading, caption, width, height}`. */
export function parseEmbed(inner) {
  const [left, ...rest] = String(inner).split("|");
  const hash = left.indexOf("#");
  const target = (hash < 0 ? left : left.slice(0, hash)).trim();
  const heading = hash < 0 ? null : left.slice(hash + 1).trim() || null;
  let width = null;
  let height = null;
  const caption = [];
  for (const part of rest) {
    const p = part.trim();
    if (SIZE.test(p) && width === null) {
      const [w, h] = p.split("x");
      width = Number(w);
      height = h ? Number(h) : null;
    } else if (p) caption.push(p);
  }
  return { target, heading, caption: caption.join("|") || null, width, height };
}

/** An embed's inside from its parts (the caption before the size, as docs/PLAN.md writes it). */
export function formatEmbed({ target, heading = null, caption = null, width = null, height = null }) {
  let s = heading ? `${target}#${heading}` : target;
  if (caption) s += `|${caption}`;
  if (width) s += `|${Math.round(width)}${height ? `x${Math.round(height)}` : ""}`;
  return s;
}

/** The same embed with a new width (null: no size). */
export function setEmbedWidth(inner, w) {
  return formatEmbed({ ...parseEmbed(inner), width: w ? Math.max(16, Math.round(w)) : null, height: null });
}

/** The part of a page's body under a heading (to the next heading of the same or a higher level), or null. */
export function sectionOf(body, heading) {
  const lines = String(body ?? "").split("\n");
  const norm = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const want = norm(heading);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^ {0,3}(```|~~~)/.test(lines[i])) fence = !fence;
    const m = !fence && /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m || norm(m[2]) !== want) continue;
    const level = m[1].length;
    let end = i + 1;
    let f = false;
    for (; end < lines.length; end++) {
      if (/^ {0,3}(```|~~~)/.test(lines[end])) f = !f;
      const h = !f && /^ {0,3}(#{1,6})\s/.exec(lines[end]);
      if (h && h[1].length <= level) break;
    }
    return lines.slice(i, end).join("\n").trim();
  }
  return null;
}

/** A page body's headings: `[{level, text, line}]` (code blocks left out). */
export function headingsOf(body) {
  const out = [];
  let fence = false;
  String(body ?? "").split("\n").forEach((line, i) => {
    if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  });
  return out;
}

// ---------- counting, matching, dates ----------

/** Words, characters and reading time of a page's text (properties, Markdown marks and HTML tags left out). */
export function countWords(text) {
  let s = String(text ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(/^---\n[\s\S]*?\n(---|\.\.\.)[ \t]*(\n|$)/, "");
  s = s.replace(/%%[\s\S]*?%%/g, " ")
    .replace(/<\/?(u|sup|sub|mark|span)\b[^>]*>/gi, "")
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^ {0,3}(```|~~~).*$/gm, "")
    .replace(/^\s*>\s*\[![\w-]+\][+-]?/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*(#{1,6}|>+|\|?\s*:?-{3,}.*)\s*/gm, "");
  const cjk = s.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0;
  const words = (s.replace(/[぀-ヿ㐀-鿿가-힯]/g, " ")
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’_.-]*/gu)?.length ?? 0) + cjk;
  const chars = s.replace(/\s/g, "").length;
  return { words, chars, readingMinutes: words ? Math.max(1, Math.round(words / 230)) : 0 };
}

/**
 * How well `query` matches `text` (higher is better), or -1: every query character must appear in order. Starts of
 * the text and of words score most, then runs of consecutive characters.
 */
export function fuzzyScore(query, text) {
  const q = String(query ?? "").toLowerCase().trim();
  const t = String(text ?? "").toLowerCase();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - t.length;
  const at = t.indexOf(q);
  if (at >= 0 && /[\s\-_/(]/.test(t[at - 1] ?? " ")) return 700 - at - t.length / 10;
  // The words' first letters ("cc" → "Calvin cycle") beat a match inside a word.
  const initials = t.split(/[\s\-_/(]+/).filter(Boolean).map((w) => w[0]).join("");
  if (q.length > 1 && initials.startsWith(q.replace(/\s/g, ""))) return 600 - t.length / 10;
  if (at >= 0) return 500 - at - t.length / 10;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    score += i === prev + 1 ? 6 : /[\s\-_/(]/.test(t[i - 1] ?? " ") ? 8 : 1;
    prev = i;
    ti = i + 1;
  }
  return score - t.length / 20;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A date in a format (YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd, ddd, HH, H, mm, ss; text in [brackets] stays). The
 * editor's own copy, used when shared/templates.js (which has the same function) can't be loaded.
 */
export function formatDate(date, format = "YYYY-MM-DD") {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const map = {
    YYYY: d.getFullYear(), YY: p(d.getFullYear() % 100), MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: p(d.getMonth() + 1), M: d.getMonth() + 1, DD: p(d.getDate()), D: d.getDate(), dddd: DAYS[d.getDay()],
    ddd: DAYS[d.getDay()].slice(0, 3), HH: p(d.getHours()), H: d.getHours(), mm: p(d.getMinutes()), ss: p(d.getSeconds()),
  };
  return String(format).replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g,
    (m, lit) => (lit !== undefined ? lit : String(map[m])));
}
