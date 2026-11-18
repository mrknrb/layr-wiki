import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, diffStats, foldDiff } from "../shared/diff.js";
import { cleanFileName, sha256Hex } from "../shared/files.js";
import { parseYaml, setProperties, splitFrontmatter, stringifyYaml } from "../shared/frontmatter.js";
import { cleanTitle, extractLinks, inlineTags, linkTargets, maskCode, mentions, renameLinks, titleProblem } from
  "../shared/links.js";
import { renderMarkdown } from "../shared/markdown.js";
import { ancestors, checkFolder, cleanFolder, compareFolders, fixFolder, folderKey, folderProblem, isInside, joinPath,
  moveInto, nameOf, parentOf } from "../shared/folders.js";
import { describeProposal, hunks, merge3 } from "../shared/proposals.js";
import { GROUPS, normalizeSettings, readSettings, SETTINGS, writeSettings } from "../shared/settings.js";
import { dailyPath, dailyTitle, fillTemplate, formatDate, toDate } from "../shared/templates.js";
import { cleanType, DEFAULT_TYPE_ICON, fieldValue, findType, formatField, normalizeType, parseFieldInput,
  templateFor } from "../shared/types.js";

test("frontmatter: reads Obsidian's properties", () => {
  const md = [
    "---",
    "type: Book",
    'aliases: [TFS, "Fast and Slow"]',
    "tags:",
    "  - psychology",
    "  - decisions",
    'author: "[[Daniel Kahneman]]"',
    "publisher: [[Farrar]]",
    "pages: 499",
    "read: true",
    "empty:",
    "---",
    "",
    "Body text",
  ].join("\n");
  const { props, body } = splitFrontmatter(md);
  assert.equal(body, "Body text");
  assert.deepEqual(props, {
    type: "Book",
    aliases: ["TFS", "Fast and Slow"],
    tags: ["psychology", "decisions"],
    author: "[[Daniel Kahneman]]",
    publisher: "[[Farrar]]",
    pages: 499,
    read: true,
    empty: null,
  });
});

test("frontmatter: no block, unclosed block, CRLF", () => {
  assert.deepEqual(splitFrontmatter("just text"), { yaml: null, body: "just text", props: {} });
  assert.equal(splitFrontmatter("---\ntype: x\nno end").yaml, null);
  assert.equal(splitFrontmatter("---\r\ntype: Paper\r\n---\r\nHi").props.type, "Paper");
});

test("frontmatter: setProperties changes only the keys it is given", () => {
  const md = "---\ntype: Book\n# a comment\nnested:\n  a: 1\ntags:\n  - x\n---\n\nText";
  const out = setProperties(md, { tags: ["x", "y"], isbn: "978-0374533557", type: null });
  assert.equal(out, "---\n# a comment\nnested:\n  a: 1\ntags:\n  - x\n  - y\nisbn: 978-0374533557\n---\n\nText");
  assert.equal(setProperties("Plain", { type: "Note" }), "---\ntype: Note\n---\n\nPlain");
  assert.equal(setProperties("---\ntype: Note\n---\n\nPlain", { type: null }), "Plain");
  assert.throws(() => setProperties("x", { "bad: key": 1 }));
});

test("frontmatter: values that need quotes round-trip", () => {
  const props = { a: "[[Link]]", b: "x: y", c: "123", d: "true", e: "plain words", f: ["#tag", "ok"], g: 5 };
  assert.deepEqual(parseYaml(stringifyYaml(props)), props);
});

test("links: extraction, labels, headings, embeds, code ignored", () => {
  const md = "See [[Garden]], [[Compost|the heap]] and [[Garden#Beds]].\n![[plan.png|300]]\n`[[not]]`\n```\n[[no]]\n```";
  const links = extractLinks(md);
  assert.deepEqual(
    links.map((l) => [l.target, l.heading, l.label, l.embed]),
    [["Garden", null, null, false], ["Compost", null, "the heap", false], ["Garden", "Beds", null, false],
      ["plan.png", null, "300", true]],
  );
  assert.deepEqual(linkTargets(md), ["Garden", "Compost"]);
  assert.equal(maskCode("a `[[b]]` c").includes("[["), false);
});

test("links: rename keeps labels and headings, skips code", () => {
  const md = "[[q3 plan]] [[Q3 Plan|it]] [[Q3 Plan#Goals|g]] ![[Q3 Plan]] `[[Q3 Plan]]` [[Q3 Plan B]]";
  const { markdown, count } = renameLinks(md, "Q3 Plan", "Plan for Q3");
  assert.equal(count, 4);
  assert.equal(
    markdown,
    "[[Plan for Q3]] [[Plan for Q3|it]] [[Plan for Q3#Goals|g]] ![[Plan for Q3]] `[[Q3 Plan]]` [[Q3 Plan B]]",
  );
});

test("links: titles, tags, mentions", () => {
  assert.equal(titleProblem("Q3 Plan"), null);
  assert.match(titleProblem("a/b"), /can't hold/);
  assert.match(titleProblem("CON"), /Windows/);
  assert.match(titleProblem(" x"), /space/);
  assert.equal(cleanTitle("What: a [test]?"), "What- a -test-");
  assert.deepEqual(inlineTags("# Heading\nText #work/notes and #2024 #idea.\n`#code`"), ["work/notes", "idea"]);
  assert.equal(mentions("The Garden needs water.", "garden"), true);
  assert.equal(mentions("The [[Garden]] needs water.", "Garden"), false);
  assert.equal(mentions("Gardener", "Garden"), false);
});

test("markdown: links, missing pages, embeds, callouts, tags", () => {
  const resolve = (t) => (t === "Ann Lee" ? { title: "Ann Lee", exists: true } : { title: t, exists: false });
  const html = renderMarkdown(
    "## Agenda\n\nAsk [[Ann Lee|Ann]] and [[Nope]]. ==key== %%hidden%% #idea $E=mc^2$\n\n![[plan.png]]\n\n" +
      "> [!warning] Careful\n> Hot\n\n<script>x</script>",
    { resolve },
  );
  assert.match(html, /<h2 id="agenda"[^>]*>Agenda<\/h2>/);
  assert.match(html, /<a class="wl" href="#" data-page="Ann Lee"[^>]*>Ann<\/a>/);
  assert.match(html, /<a class="wl missing" href="#" data-page="Nope"/);
  assert.match(html, /<mark>key<\/mark>/);
  assert.doesNotMatch(html, /hidden/);
  assert.match(html, /data-tag="idea"/);
  assert.match(html, /<span class="math">E=mc\^2<\/span>/);
  assert.match(html, /<img class="att" data-file="plan.png"/);
  assert.match(html, /data-callout="warning"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("markdown: dangerous links are neutralised", () => {
  const html = renderMarkdown("[x](javascript:alert(1)) [y](https://example.org)");
  assert.match(html, /href="#"/);
  assert.match(html, /href="https:\/\/example.org" target="_blank"/);
});

test("types: templates, 0.1 records, checks", () => {
  const book = cleanType({ name: "Book", fields: [{ key: "author", kind: "link" }, { key: "tags_x", kind: "list" }],
    template: "## Summary\n\n\n" });
  assert.deepEqual(book.fields.map((f) => f.kind), ["link", "multiselect"]);
  assert.equal(book.icon, DEFAULT_TYPE_ICON);
  assert.equal(book.template, "## Summary\n");
  const md = templateFor(book, { stringify: stringifyYaml });
  const { props, body } = splitFrontmatter(md);
  assert.deepEqual(props, { type: "Book", author: null, tags_x: [] });
  assert.equal(body, "## Summary\n");
  assert.throws(() => cleanType({ name: "1st" }), /name/);
  assert.throws(() => cleanType({ name: "T", fields: [{ key: "type" }] }), /every page has/);
  assert.throws(() => cleanType({ name: "T", fields: [{ key: "a" }, { key: "a" }] }), /twice/);
  assert.equal(normalizeType({ name: "Old", fields: [{ key: "x", kind: "weird" }] }).fields[0].kind, "text");
  assert.equal(normalizeType(null), null);
  assert.equal(findType([book], "BOOK"), book);
  assert.equal(findType([book], null), null);
});

test("types: field values for the info box and editors", () => {
  const page = { props: { n: "42", d: "2026-11-18T10:00:00Z", c: "yes", m: "a", l: "[[Ann Lee|Ann]]", ls: ["[[A]]", "B"],
    f: "![[paper.pdf]]", t: ["x", "y"], u: "https://example.org", e: "" } };
  const v = (key, kind, extra = {}) => fieldValue(page, { key, kind, ...extra });
  assert.equal(v("n", "number"), 42);
  assert.equal(v("d", "date"), "2026-11-18T10:00");
  assert.equal(v("c", "checkbox"), true);
  assert.equal(v("missing", "checkbox"), false);
  assert.deepEqual(v("m", "multiselect"), ["a"]);
  assert.equal(v("l", "link"), "Ann Lee");
  assert.deepEqual(v("ls", "link"), ["A", "B"]);
  assert.deepEqual(v("l", "link", { multiple: true }), ["Ann Lee"]);
  assert.equal(v("f", "file"), "paper.pdf");
  assert.equal(v("t", "text"), "x, y");
  assert.equal(v("e", "text"), null);
  assert.equal(v("u", "url"), "https://example.org");
  assert.equal(formatField(true, { kind: "checkbox" }), "Yes");
  assert.equal(formatField(["a", "b"], { kind: "multiselect" }), "a, b");
  assert.equal(formatField(null), "");
  assert.equal(parseFieldInput("number", "3,5"), 3.5);
  assert.throws(() => parseFieldInput("number", "abc"), /Not a number/);
  assert.equal(parseFieldInput("number", ""), null);
  assert.equal(parseFieldInput("date", "2026-1-5"), "2026-01-05");
  assert.throws(() => parseFieldInput("date", "5 Jan"), /YYYY-MM-DD/);
  assert.equal(parseFieldInput("checkbox", "no"), false);
  assert.equal(parseFieldInput("checkbox", true), true);
  assert.deepEqual(parseFieldInput("multiselect", "a, b,, c"), ["a", "b", "c"]);
  assert.deepEqual(parseFieldInput("multiselect", ""), []);
  assert.equal(parseFieldInput("link", "Ann Lee"), "[[Ann Lee]]");
  assert.equal(parseFieldInput("link", "[[Ann Lee]]"), "[[Ann Lee]]");
  assert.deepEqual(parseFieldInput("link", "A, [[B]]", { multiple: true }), ["[[A]]", "[[B]]"]);
  assert.equal(parseFieldInput("file", "paper.pdf"), "[[paper.pdf]]");
  assert.equal(parseFieldInput("text", "  hi "), "hi");
  // What parseFieldInput stores, fieldValue reads back.
  for (const [kind, text] of [["number", "7"], ["date", "2026-02-03"], ["multiselect", "x, y"], ["link", "Ann"]]) {
    const stored = parseFieldInput(kind, text);
    assert.equal(formatField(fieldValue({ k: stored }, { key: "k", kind }), { kind }), text);
  }
});

test("folders: clean, check, parents, inside, rename paths, sort", () => {
  assert.equal(cleanFolder(" \\Projects\\ Thesis //Drafts/ "), "Projects/Thesis/Drafts");
  assert.equal(cleanFolder(null), "");
  assert.equal(folderProblem(""), null);
  assert.equal(folderProblem("A/B c"), null);
  assert.match(folderProblem("A/b:c"), /Folder "b:c": a name can't hold/);
  assert.match(folderProblem("A/CON"), /Windows/);
  assert.throws(() => checkFolder("x/y?"), /can't hold/);
  assert.equal(fixFolder("a:b/c?"), "a-b/c-");
  assert.equal(parentOf("a/b/c"), "a/b");
  assert.equal(parentOf("a"), "");
  assert.equal(nameOf("a/b/c"), "c");
  assert.equal(joinPath("", "T"), "T");
  assert.equal(joinPath("a/b", "T"), "a/b/T");
  assert.ok(isInside("A/B", "a"));
  assert.ok(isInside("a", "A"));
  assert.ok(!isInside("ab", "a"));
  assert.ok(isInside("anything", ""));
  assert.deepEqual(ancestors("a/b/c"), ["a", "a/b", "a/b/c"]);
  assert.equal(moveInto("a/b/c", "A/b", "x"), "x/c");
  assert.equal(moveInto("q", "a", "x"), "q");
  assert.equal(folderKey("Projects/Thesis"), "folder/projects/thesis");
  assert.deepEqual(["b", "a/z", "A", "a/b", "Item 10", "Item 9"].sort(compareFolders),
    ["A", "a/b", "a/z", "b", "Item 9", "Item 10"]);
});

test("templates: dates, placeholders, daily note titles", () => {
  const d = new Date(2026, 10, 8, 7, 5, 9);
  assert.equal(formatDate(d, "YYYY-MM-DD HH:mm:ss"), "2026-11-08 07:05:09");
  assert.equal(formatDate(d, "dddd, D MMMM YY"), "Sunday, 8 November 26");
  assert.equal(formatDate(d, "ddd D MMM, H:mm"), "Sun 8 Nov, 7:05");
  assert.equal(formatDate(d, "[Week of] M/D"), "Week of 11/8");
  assert.equal(formatDate("2026-01-02", "D.M.YYYY"), "2.1.2026");
  assert.equal(toDate("2026-01-02").getDate(), 2);
  assert.throws(() => toDate("not a date"), /Not a date/);
  const text = "# {{title}}\n{{date}} {{time}} {{ date:YYYY }} {{time:HH}} {{other}}";
  assert.equal(fillTemplate(text, { title: "Plan", date: d }), "# Plan\n2026-11-08 07:05 2026 07 {{other}}");
  assert.equal(fillTemplate("{{date}}", { date: d, settings: { dateFormat: "DD/MM/YYYY" } }), "08/11/2026");
  assert.equal(dailyTitle(d), "2026-11-08");
  assert.deepEqual(dailyPath(d, { dailyFolder: "Journal", dailyFormat: "YYYY/MMMM/D MMM" }),
    { folder: "Journal/2026/November", title: "8 Nov" });
  assert.deepEqual(dailyPath(d, { dailyFolder: "" }), { folder: "", title: "2026-11-08" });
});

test("proposals: three-way merge of line changes", () => {
  const base = "a\nb\nc\nd\ne";
  assert.deepEqual(merge3(base, base, "a\nB\nc\nd\ne"), { ok: true, text: "a\nB\nc\nd\ne" });
  assert.deepEqual(merge3(base, "A\nb\nc\nd\ne", "a\nb\nc\nd\nE"), { ok: true, text: "A\nb\nc\nd\nE" });
  assert.deepEqual(merge3(base, "a\nb\nnew\nc\nd\ne", "a\nb\nc\nd\ne\nend"),
    { ok: true, text: "a\nb\nnew\nc\nd\ne\nend" });
  assert.deepEqual(merge3(base, "a\nc\nd\ne", "a\nb\nc\nd\nE"), { ok: true, text: "a\nc\nd\nE" });
  assert.deepEqual(merge3(base, "a\nX\nc\nd\ne", "a\nX\nc\nd\ne"), { ok: true, text: "a\nX\nc\nd\ne" });
  const clash = merge3(base, "a\nmine\nc\nd\ne", "a\ntheirs\nc\nd\ne");
  assert.equal(clash.ok, false);
  assert.equal(clash.conflicts[0].line, 2);
  assert.equal(merge3("a\nb", "a\nx\nb", "a\ny\nb").ok, false, "two different insertions at one place");
  assert.deepEqual(hunks("a\nb\nc", "a\nB\nc"), [{ start: 1, end: 2, lines: ["B"] }]);
  assert.equal(describeProposal({ op: "move", title: "P", folder: "" }), "move [[P]] to the top folder");
  assert.equal(describeProposal({ op: "rename", title: "P", newTitle: "Q" }), "rename [[P]] to [[Q]]");
});

test("settings: defaults, checks, read and write", async () => {
  const s = normalizeSettings({ fontSize: 99, theme: "neon", aiReview: 1, colors: "red" });
  assert.equal(s.fontSize, 24);
  assert.equal(s.theme, "layr");
  assert.equal(s.aiReview, true);
  assert.equal(s.colors.length, 8);
  const kv = new Map();
  const adapter = { dataGet: async (k) => kv.get(k) ?? null, dataSet: async (k, v) => kv.set(k, v) };
  assert.equal((await readSettings(adapter)).historyMinutes, 10);
  await writeSettings(adapter, { historyMinutes: 3 });
  assert.equal((await readSettings(adapter)).historyMinutes, 3);
  await writeSettings(adapter, { historyMinutes: null });
  assert.equal((await readSettings(adapter)).historyMinutes, 10);
  await assert.rejects(writeSettings(adapter, { nope: 1 }), /No setting/);
  assert.ok(SETTINGS.every((x) => GROUPS.some((g) => g.id === x.group)));
});

test("diff: lines added and removed, folded", () => {
  const ops = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(diffStats(ops), { add: 2, del: 1 });
  const many = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const folded = foldDiff(diffLines(many.join("\n"), [...many.slice(0, 19), "x"].join("\n")));
  assert.equal(folded[0].op, "skip");
});

test("files: names and sha256", async () => {
  assert.equal(cleanFileName("C:\\x\\gel [1].png"), "gel -1-.png");
  assert.equal(cleanFileName("noext"), "noext.bin");
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
