import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, diffStats, foldDiff } from "../shared/diff.js";
import { cleanFileName, sha256Hex } from "../shared/files.js";
import { parseYaml, setProperties, splitFrontmatter, stringifyYaml } from "../shared/frontmatter.js";
import { cleanTitle, extractLinks, inlineTags, linkTargets, maskCode, mentions, renameLinks, titleProblem } from
  "../shared/links.js";
import { renderMarkdown } from "../shared/markdown.js";
import { BUILT_IN_TYPES, mergeTypes, templateFor } from "../shared/types.js";

test("frontmatter: reads Obsidian's properties", () => {
  const md = [
    "---",
    "type: Gene",
    'aliases: [p53, "TP53 protein"]',
    "tags:",
    "  - tumor-suppressor",
    "  - cancer",
    'organism: "[[Homo sapiens]]"',
    "protein: [[p53 protein]]",
    "length_aa: 393",
    "reviewed: true",
    "empty:",
    "---",
    "",
    "Body text",
  ].join("\n");
  const { props, body } = splitFrontmatter(md);
  assert.equal(body, "Body text");
  assert.deepEqual(props, {
    type: "Gene",
    aliases: ["p53", "TP53 protein"],
    tags: ["tumor-suppressor", "cancer"],
    organism: "[[Homo sapiens]]",
    protein: "[[p53 protein]]",
    length_aa: 393,
    reviewed: true,
    empty: null,
  });
});

test("frontmatter: no block, unclosed block, CRLF", () => {
  assert.deepEqual(splitFrontmatter("just text"), { yaml: null, body: "just text", props: {} });
  assert.equal(splitFrontmatter("---\ntype: x\nno end").yaml, null);
  assert.equal(splitFrontmatter("---\r\ntype: Paper\r\n---\r\nHi").props.type, "Paper");
});

test("frontmatter: setProperties changes only the keys it is given", () => {
  const md = "---\ntype: Gene\n# a comment\nnested:\n  a: 1\ntags:\n  - x\n---\n\nText";
  const out = setProperties(md, { tags: ["x", "y"], uniprot: "P04637", type: null });
  assert.equal(out, "---\n# a comment\nnested:\n  a: 1\ntags:\n  - x\n  - y\nuniprot: P04637\n---\n\nText");
  assert.equal(setProperties("Plain", { type: "Note" }), "---\ntype: Note\n---\n\nPlain");
  assert.equal(setProperties("---\ntype: Note\n---\n\nPlain", { type: null }), "Plain");
  assert.throws(() => setProperties("x", { "bad: key": 1 }));
});

test("frontmatter: values that need quotes round-trip", () => {
  const props = { a: "[[Link]]", b: "x: y", c: "123", d: "true", e: "plain words", f: ["#tag", "ok"], g: 5 };
  assert.deepEqual(parseYaml(stringifyYaml(props)), props);
});

test("links: extraction, labels, headings, embeds, code ignored", () => {
  const md = "See [[TP53]], [[MDM2|the ligase]] and [[TP53#Function]].\n![[gel.png|300]]\n`[[not]]`\n```\n[[no]]\n```";
  const links = extractLinks(md);
  assert.deepEqual(
    links.map((l) => [l.target, l.heading, l.label, l.embed]),
    [["TP53", null, null, false], ["MDM2", null, "the ligase", false], ["TP53", "Function", null, false],
      ["gel.png", null, "300", true]],
  );
  assert.deepEqual(linkTargets(md), ["TP53", "MDM2"]);
  assert.equal(maskCode("a `[[b]]` c").includes("[["), false);
});

test("links: rename keeps labels and headings, skips code", () => {
  const md = "[[tp53]] [[TP53|p53]] [[TP53#Function|f]] ![[TP53]] `[[TP53]]` [[TP531]]";
  const { markdown, count } = renameLinks(md, "TP53", "Tumor protein p53");
  assert.equal(count, 4);
  assert.equal(
    markdown,
    "[[Tumor protein p53]] [[Tumor protein p53|p53]] [[Tumor protein p53#Function|f]] ![[Tumor protein p53]] " +
      "`[[TP53]]` [[TP531]]",
  );
});

test("links: titles, tags, mentions", () => {
  assert.equal(titleProblem("TP53"), null);
  assert.match(titleProblem("a/b"), /can't hold/);
  assert.match(titleProblem("CON"), /Windows/);
  assert.match(titleProblem(" x"), /space/);
  assert.equal(cleanTitle("What: a [test]?"), "What- a -test-");
  assert.deepEqual(inlineTags("# Heading\nText #lab/notes and #2024 #cancer.\n`#code`"), ["lab/notes", "cancer"]);
  assert.equal(mentions("The MDM2 gene binds p53.", "mdm2"), true);
  assert.equal(mentions("The [[MDM2]] gene.", "MDM2"), false);
  assert.equal(mentions("MDM2x", "MDM2"), false);
});

test("markdown: links, missing pages, embeds, callouts, tags", () => {
  const resolve = (t) => (t === "TP53" ? { title: "TP53", exists: true } : { title: t, exists: false });
  const html = renderMarkdown(
    "## Function\n\nBinds [[TP53|p53]] and [[Nope]]. ==key== %%hidden%% #cancer $E=mc^2$\n\n![[gel.png]]\n\n" +
      "> [!warning] Careful\n> Toxic\n\n<script>x</script>",
    { resolve },
  );
  assert.match(html, /<h2 id="function">Function<\/h2>/);
  assert.match(html, /<a class="wl" href="#" data-page="TP53"[^>]*>p53<\/a>/);
  assert.match(html, /<a class="wl missing" href="#" data-page="Nope"/);
  assert.match(html, /<mark>key<\/mark>/);
  assert.doesNotMatch(html, /hidden/);
  assert.match(html, /data-tag="cancer"/);
  assert.match(html, /<span class="math">E=mc\^2<\/span>/);
  assert.match(html, /<img class="att" data-file="gel.png"/);
  assert.match(html, /data-callout="warning"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("markdown: dangerous links are neutralised", () => {
  const html = renderMarkdown("[x](javascript:alert(1)) [y](https://example.org)");
  assert.match(html, /href="#"/);
  assert.match(html, /href="https:\/\/example.org" target="_blank"/);
});

test("types: templates and merging", () => {
  const gene = BUILT_IN_TYPES.find((t) => t.name === "Gene");
  const md = templateFor(gene, { stringify: stringifyYaml });
  const { props, body } = splitFrontmatter(md);
  assert.equal(props.type, "Gene");
  assert.ok("uniprot" in props === false && "symbol" in props);
  assert.match(body, /## Function/);
  const merged = mergeTypes([{ name: "gene", icon: "G" }, { name: "Cell line", fields: [] }]);
  assert.equal(merged.find((t) => t.name.toLowerCase() === "gene").icon, "G");
  assert.ok(merged.some((t) => t.name === "Cell line" && !t.builtIn));
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
