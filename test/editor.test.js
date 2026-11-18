// The editor's pure text operations (panels/editor/markdown-ops.js): formatting toggles, colours, headings, lists,
// callouts, Enter and Backspace in lists, tables, image sizes, sections, word counts, fuzzy matching, dates.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeFormats, applyEdit, backspaceMarker, codeBlock, continueList, countWords, formatDate, fuzzyScore, headingsOf,
  htmlSpans, insertBlock, insertCallout, mapPos, mathBlock, newTable, parseEmbed, parseTable, safeColor, sectionOf,
  serializeTable, setColor, setEmbedWidth, setHeading, setHighlight, tableOps, toggleFormat, toggleLines, toggleLink,
  toggleTask,
} from "../panels/editor/markdown-ops.js";

/** Run an op on text with the selection marked «like this» (or a cursor ‸); give the result marked the same way. */
function run(marked, op) {
  const from = marked.search(/[«‸]/);
  const to = marked.includes("‸") ? from : marked.indexOf("»") - 1;
  const text = marked.replace(/[«»‸]/g, "");
  const e = op(text, from, to);
  if (!e) return null;
  const out = applyEdit(text, e);
  const [a, b] = [Math.min(e.anchor, e.head), Math.max(e.anchor, e.head)];
  return a === b ? `${out.slice(0, a)}‸${out.slice(a)}` : `${out.slice(0, a)}«${out.slice(a, b)}»${out.slice(b)}`;
}
const fmt = (name) => (t, a, b) => toggleFormat(t, a, b, name);

test("bold wraps a selection and the same again removes it", () => {
  assert.equal(run("one «two» three", fmt("bold")), "one **«two»** three");
  assert.equal(run("one **«two»** three", fmt("bold")), "one «two» three");
  assert.equal(run("one «**two**» three", fmt("bold")), "one «two» three");
  assert.equal(run("one **t‸wo** three", fmt("bold")), "one t‸wo three");
});

test("an empty selection takes the word, or leaves the cursor between the marks", () => {
  assert.equal(run("one tw‸o", fmt("italic")), "one *tw‸o*");
  assert.equal(run("one ‸", fmt("bold")), "one **‸**");
});

test("spaces at the ends of a selection stay outside the marks", () => {
  assert.equal(run("a« word »b", fmt("strike")), "a ~~«word»~~ b");
});

test("italic is not confused with bold", () => {
  assert.equal(run("**b«ol»d**", fmt("italic")), "**b*«ol»*d**");
  assert.equal(run("*it«al»ic*", fmt("italic")), "it«al»ic");
});

test("html formats: underline, sup, sub", () => {
  assert.equal(run("E = mc«2»", fmt("sup")), "E = mc<sup>«2»</sup>");
  assert.equal(run("H<sub>«2»</sub>O", fmt("sub")), "H«2»O");
  assert.equal(run("«under»", fmt("underline")), "<u>«under»</u>");
});

test("activeFormats sees the formats around the selection", () => {
  const t = "**bold <u>und</u>** ==hi== <span style=\"color:#e03e3e\">red</span>";
  assert.deepEqual([...activeFormats(t, 11, 11)].sort(), ["bold", "underline"]);
  assert.ok(activeFormats(t, 22, 22).has("highlight"));
  assert.ok(activeFormats(t, 55, 56).has("color"));
});

test("colour: set, change and remove", () => {
  const set = (c) => (t, a, b) => setColor(t, a, b, c);
  assert.equal(run("«red» text", set("#e03e3e")), '<span style="color:#e03e3e">«red»</span> text');
  assert.equal(run('<span style="color:#e03e3e">r‸ed</span>', set("#0b6e99")), '<span style="color:#0b6e99">r‸ed</span>');
  assert.equal(run('<span style="color:#e03e3e">r‸ed</span>', set(null)), "r‸ed");
  assert.equal(run('«a <span style="color:red">b</span> c»', set(null)), "«a b c»");
  assert.equal(run("«plain»", set(null)), null);
  assert.throws(() => setColor("x", 0, 1, "url(evil)"), /Not a colour/);
});

test("highlight: default ==, a colour makes a mark, null removes either", () => {
  const hl = (c) => (t, a, b) => setHighlight(t, a, b, c);
  assert.equal(run("«hi»", hl(undefined)), "==«hi»==");
  assert.equal(run("==«hi»==", hl(undefined)), "«hi»");
  assert.equal(run("==h‸i==", hl("#0f7b6c")), '<mark style="background:#0f7b6c">h‸i</mark>');
  assert.equal(run('<mark style="background:#0f7b6c">h‸i</mark>', hl("#ad1a72")), '<mark style="background:#ad1a72">h‸i</mark>');
  assert.equal(run('<mark style="background:#0f7b6c">h‸i</mark>', hl(null)), "h‸i");
  assert.equal(run("==h‸i==", hl(null)), "h‸i");
});

test("safeColor keeps only the colour forms the wiki allows", () => {
  assert.equal(safeColor("#FFF"), "#FFF");
  assert.equal(safeColor("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
  assert.equal(safeColor("var(--accent)"), "var(--accent)");
  assert.equal(safeColor("Red"), "red");
  assert.equal(safeColor("red;background:url(x)"), null);
  assert.equal(safeColor("expression(alert(1))"), null);
});

test("htmlSpans pairs tags, reads safe styles and skips unsafe ones", () => {
  const s = htmlSpans('a <span style="color:#f00">r <u>u</u></span> <mark>m</mark> <span style="x:1">no</span>');
  assert.deepEqual(s.map((x) => x.tag), ["span", "u", "mark"]);
  assert.equal(s[0].color, "#f00");
  assert.equal(s[1].closeStart - s[1].openEnd, 1);
});

test("headings: set, change, toggle off", () => {
  const hd = (n) => (t, a, b) => setHeading(t, a, b, n);
  assert.equal(run("Ti‸tle", hd(2)), "## Ti‸tle");
  assert.equal(run("## Ti‸tle", hd(3)), "### Ti‸tle");
  assert.equal(run("### Ti‸tle", hd(3)), "Ti‸tle");
  assert.equal(run("# Ti‸tle", hd(0)), "Ti‸tle");
});

test("lists: bullet, numbered, task and quote on several lines, and off again", () => {
  const ln = (k) => (t, a, b) => toggleLines(t, a, b, k);
  assert.equal(run("«a\nb»", ln("bullet")), "- «a\n- b»");
  assert.equal(run("- «a\n- b»", ln("bullet")), "«a\nb»");
  assert.equal(run("- «a\n- b»", ln("numbered")), "1. «a\n2. b»");
  assert.equal(run("x‸", ln("task")), "- [ ] x‸");
  assert.equal(run("- [ ] x‸", ln("task")), "x‸");
  assert.equal(run("«a\n\nb»", ln("quote")), "> «a\n\n> b»");
  assert.equal(run("> «a\n> b»", ln("quote")), "«a\nb»");
});

test("Ctrl+Enter ticks and unticks a task, makes one of anything else", () => {
  assert.equal(run("- [ ] x‸", toggleTask), "- [x] x‸");
  assert.equal(run("- [x] x‸", toggleTask), "- [ ] x‸");
  assert.equal(run("- item‸", toggleTask), "- [ ] item‸");
  assert.equal(run("  plain‸", toggleTask), "  - [ ] plain‸");
});

test("callouts: around lines, an empty one, and changing the kind", () => {
  assert.equal(run("«one\ntwo»", (t, a, b) => insertCallout(t, a, b, "tip")), "> [!tip]\n> one\n> two‸");
  assert.equal(run("‸", (t, a, b) => insertCallout(t, a, b, "note")), "> [!note]\n> ‸");
  assert.equal(run("> [!note] T‸itle", (t, a, b) => insertCallout(t, a, b, "warning")), "> [!warning] T‸itle");
});

test("blocks go on their own line", () => {
  assert.equal(run("text‸", (t, a) => insertBlock(t, a, "---", 3)), "text\n---‸");
  assert.equal(run("‸", (t, a, b) => codeBlock(t, a, b, "js")), "```js\n‸\n```");
  assert.equal(run("«a = 1»", (t, a, b) => codeBlock(t, a, b, "")), "```\n«a = 1»\n```");
  assert.equal(run("x «y» z", mathBlock), "x $«y»$ z");
  assert.equal(run("‸", mathBlock), "$$\n‸\n$$");
});

test("links: text → [[text]], a URL → [](url), inside a link → plain text", () => {
  assert.equal(run("see «Page»", (t, a, b) => toggleLink(t, a, b)), "see [[«Page»]]");
  assert.equal(run("«https://x.org»", (t, a, b) => toggleLink(t, a, b)), "[‸](https://x.org)");
  assert.equal(run("[[Pa‸ge|Label]]", (t, a, b) => toggleLink(t, a, b)), "«Label»");
  assert.equal(run("‸", (t, a, b) => toggleLink(t, a, b)), "[[‸]]");
});

test("continueList: next item, next number, open box, quotes", () => {
  assert.deepEqual(continueList("- a", 3), { from: 3, to: 3, insert: "\n- ", cursor: 6 });
  assert.deepEqual(continueList("9. a", 4), { from: 4, to: 4, insert: "\n10. ", cursor: 9 });
  assert.equal(continueList("- [x] done", 10).insert, "\n- [ ] ");
  assert.equal(continueList("> quoted", 8).insert, "\n> ");
  assert.equal(continueList("> - in quote", 12).insert, "\n> - ");
  assert.equal(continueList("plain", 5), null);
  assert.equal(continueList("- a", 1), null);
});

test("continueList: an empty item ends the list, or moves out a level", () => {
  assert.deepEqual(continueList("- ", 2), { from: 0, to: 2, insert: "", cursor: 0 });
  assert.deepEqual(continueList("- [ ] ", 6), { from: 0, to: 6, insert: "", cursor: 0 });
  assert.deepEqual(continueList("    - ", 6, "    "), { from: 0, to: 6, insert: "- ", cursor: 2 });
  assert.deepEqual(continueList("> ", 2), { from: 0, to: 2, insert: "", cursor: 0 });
});

test("backspaceMarker: the box first, then the marker, a quote level at a time", () => {
  assert.deepEqual(backspaceMarker("- [ ] ", 6), { from: 2, to: 6 });
  assert.deepEqual(backspaceMarker("  - ", 4), { from: 2, to: 4 });
  assert.deepEqual(backspaceMarker("> > ", 4), { from: 2, to: 4 });
  assert.equal(backspaceMarker("- a", 3), null);
});

test("tables: parse, serialize padded, and back", () => {
  const md = "| A | Bee |\n|:--|--:|\n| 1 | x\\|y |\n| 2 |";
  const t = parseTable(md);
  assert.deepEqual(t, { header: ["A", "Bee"], align: ["left", "right"], rows: [["1", "x|y"], ["2", ""]] });
  const out = serializeTable(t);
  assert.equal(out, "| A   |  Bee |\n| :-- | ---: |\n| 1   | x\\|y |\n| 2   |      |");
  assert.deepEqual(parseTable(out), t);
  assert.equal(parseTable("no table"), null);
  assert.equal(newTable(2, 1), "| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |");
});

test("table edits: rows and columns added, moved, deleted, aligned", () => {
  let t = parseTable("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |");
  t = tableOps.insertRow(t, 1);
  assert.deepEqual(t.rows, [["1", "2"], ["", ""], ["3", "4"]]);
  t = tableOps.moveRow(tableOps.deleteRow(t, 1), 1, -1);
  assert.deepEqual(t.rows, [["3", "4"], ["1", "2"]]);
  t = tableOps.insertCol(t, 1, "new");
  assert.deepEqual(t.header, ["a", "new", "b"]);
  t = tableOps.moveCol(t, 0, 2);
  assert.deepEqual(t.header, ["new", "b", "a"]);
  t = tableOps.setAlign(tableOps.deleteCol(t, 0), 0, "center");
  assert.deepEqual(t, { header: ["b", "a"], align: ["center", null], rows: [["4", "3"], ["2", "1"]] });
  t = tableOps.setCell(t, -1, 0, "B");
  assert.equal(t.header[0], "B");
  assert.deepEqual(tableOps.deleteCol(parseTable("| a |\n| - |"), 0).header, ["a"], "the last column stays");
});

test("embeds: caption and width parsed, width rewritten", () => {
  assert.deepEqual(parseEmbed("pic.png|A caption|400"), { target: "pic.png", heading: null, caption: "A caption", width: 400,
    height: null });
  assert.deepEqual(parseEmbed("pic.png|300x200"), { target: "pic.png", heading: null, caption: null, width: 300, height: 200 });
  assert.equal(parseEmbed("Page#Sec").heading, "Sec");
  assert.equal(setEmbedWidth("pic.png", 250.4), "pic.png|250");
  assert.equal(setEmbedWidth("pic.png|cap|400", 120), "pic.png|cap|120");
  assert.equal(setEmbedWidth("pic.png|300|cap", 50), "pic.png|cap|50");
  assert.equal(setEmbedWidth("pic.png|cap|400", null), "pic.png|cap");
});

test("sections and headings of a page", () => {
  const body = "# A\nintro\n## B\nb text\n```\n# not a heading\n```\n### B1\nmore\n## C\nc";
  assert.equal(sectionOf(body, "b"), "## B\nb text\n```\n# not a heading\n```\n### B1\nmore");
  assert.equal(sectionOf(body, "missing"), null);
  assert.deepEqual(headingsOf(body).map((x) => x.text), ["A", "B", "B1", "C"]);
});

test("word count leaves out properties and syntax", () => {
  const s = countWords("---\ntags: [a, b]\n---\n# Title here\n\n- [ ] Buy **milk** and [[Page|bread]]\n\n| a | b |\n|---|---|");
  assert.equal(s.words, 8);
  assert.equal(s.readingMinutes, 1);
  assert.equal(countWords("").words, 0);
  assert.equal(countWords("日本語").words, 3);
});

test("fuzzy matching ranks starts first and needs every letter in order", () => {
  assert.ok(fuzzyScore("pho", "Photosynthesis") > fuzzyScore("pho", "Telephone"));
  assert.ok(fuzzyScore("phts", "Photosynthesis") > 0);
  assert.equal(fuzzyScore("xyz", "Photosynthesis"), -1);
  assert.ok(fuzzyScore("cc", "Calvin cycle") > fuzzyScore("cc", "accept"));
});

test("formatDate handles the template tokens", () => {
  const d = new Date(2026, 0, 5, 9, 7, 3);
  assert.equal(formatDate(d, "YYYY-MM-DD HH:mm:ss"), "2026-01-05 09:07:03");
  assert.equal(formatDate(d, "dddd D MMMM YY [at] H"), "Monday 5 January 26 at 9");
  assert.equal(formatDate(d, "ddd, MMM D"), "Mon, Jan 5");
});

test("mapPos moves positions past insertions", () => {
  const changes = [{ from: 2, to: 2, insert: "ab" }, { from: 5, to: 7, insert: "" }];
  assert.equal(mapPos(1, changes), 1);
  assert.equal(mapPos(2, changes), 4);
  assert.equal(mapPos(2, changes, -1), 2);
  assert.equal(mapPos(8, changes), 8);
});
