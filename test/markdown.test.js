// The renderer (shared/markdown.js): the HTML subset and its attacks, images with sizes and captions, PDFs, page and
// section embeds, tasks that know their line, foldable callouts; and the page part's text helpers
// (panels/page/lines.js): ticking tasks, linking mentions, backlink context, the three-way merge.
import assert from "node:assert/strict";
import test from "node:test";
import { headingsOf, imageLabel, isSafeColor, renderInline, renderMarkdown, sectionOf, textStats } from
  "../shared/markdown.js";
import { bodyOffset, findMentions, linkContexts, linkMentions, merge3, toggleTask } from "../panels/page/lines.js";

test("markdown: links, missing pages, embeds, callouts, tags", () => {
  const resolve = (t) => (t === "TP53" ? { title: "TP53", exists: true } : { title: t, exists: false });
  const html = renderMarkdown(
    "## Function\n\nBinds [[TP53|p53]] and [[Nope]]. ==key== %%hidden%% #cancer $E=mc^2$\n\n![[gel.png]]\n\n" +
      "> [!warning] Careful\n> Toxic\n\n<script>x</script>",
    { resolve },
  );
  assert.match(html, /<h2 id="function" data-line="0">Function<\/h2>/);
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
  const html = renderMarkdown("[x](javascript:alert(1)) [y](https://example.org) ![i](javascript:alert(1))");
  assert.match(html, /<a href="#">x<\/a>/);
  assert.match(html, /href="https:\/\/example.org" target="_blank"/);
  assert.match(html, /<img src="#"/);
  assert.doesNotMatch(html, /javascript:/);
});

test("html subset: colours, highlights, underline, sup and sub are kept", () => {
  const html = renderInline(
    '<span style="color:#e03e3e">red</span> <mark style="background: rgb(255, 240, 0)">hi</mark> ' +
      '<span style="background-color:var(--wiki-yellow)">v</span> <u>u</u> x<sup>2</sup> H<sub>2</sub>O ' +
      '<span style="color: Blue; background: #fff8">both</span> <mark>plain</mark>',
  );
  assert.match(html, /<span style="color:#e03e3e">red<\/span>/);
  assert.match(html, /<mark style="background:rgb\(255, 240, 0\)">hi<\/mark>/);
  assert.match(html, /<span style="background-color:var\(--wiki-yellow\)">v<\/span>/);
  assert.match(html, /<u>u<\/u> x<sup>2<\/sup> H<sub>2<\/sub>O/);
  assert.match(html, /<span style="color:Blue;background:#fff8">both<\/span>/);
  assert.match(html, /<mark>plain<\/mark>/);
  // Formatting inside and around the tags still works.
  assert.match(renderInline('<span style="color:red">**bold** [[Page]]</span>'),
    /<span style="color:red"><strong>bold<\/strong> <a class="wl"[^>]*>Page<\/a><\/span>/);
});

test("html subset: attacks stay escaped", () => {
  const attacks = [
    '<span style="background:url(x)">a</span>',
    '<span style="background:url(javascript:alert(1))">a</span>',
    '<span onclick="alert(1)">a</span>',
    '<span style="color:red" onmouseover="alert(1)">a</span>',
    '<span style="color:expression(alert(1))">a</span>',
    '<span style="position:fixed;top:0">a</span>',
    '<span style="color:red;width:9999px">a</span>',
    '<span style=color:red>a</span>',
    '<mark style="color:red">a</mark>',
    '<u style="color:red">a</u>',
    '<span style="color:#e03e3e">never closed',
    "closed only</span>",
    '<a href="javascript:alert(1)">a</a>',
    '<img src=x onerror="alert(1)">',
    "<script>alert(1)</script>",
    "<iframe src=x></iframe>",
    '<svg onload="alert(1)">',
    '<span style="color:red">a<span>',
    '<span style="background:#fff\\" onclick=\\"x">a</span>',
  ];
  for (const raw of attacks) {
    const html = renderInline(raw);
    assert.doesNotMatch(html, /<(a|img|script|iframe|svg)\b/i, raw);
    assert.doesNotMatch(html, /<span[^>]*(onclick|onmouseover|url|expression|position|width)/i, raw);
    assert.doesNotMatch(html, /<(mark|u) style="color/i, raw);
    assert.doesNotMatch(html, /\son\w+="/i, raw);
  }
  assert.equal(renderInline('<span style="background:url(x)">a</span>'),
    "&lt;span style=&quot;background:url(x)&quot;&gt;a&lt;/span&gt;");
  // A tag in a code span stays code.
  assert.match(renderInline('`<span style="color:red">x</span>`'), /<code>&lt;span/);
  // Unbalanced: the closer without an opener is text, the pair is kept.
  assert.match(renderInline('<u>a</u></u>'), /^<u>a<\/u>&lt;\/u&gt;$/);
});

test("html subset: colour values", () => {
  for (const ok of ["#abc", "#abcd", "#aabbcc", "#aabbccdd", "rgb(1,2,3)", "rgba(1, 2, 3, 0.5)", "rgb(10% 20% 30% / 50%)",
    "var(--accent)", "red", "transparent"]) assert.ok(isSafeColor(ok), ok);
  for (const bad of ["#ab", "#abcde", "url(x)", "rgb(1,2)", "var(accent)", "red;", "expression(x)", "red blue", "",
    "rgb(1,2,3) url(x)", "javascript:x"]) assert.ok(!isSafeColor(bad), bad);
});

test("images: sizes and captions", () => {
  assert.deepEqual(imageLabel("A caption|400"), { caption: "A caption", width: 400, height: null });
  assert.deepEqual(imageLabel("400x300"), { caption: null, width: 400, height: 300 });
  assert.deepEqual(imageLabel("Just words"), { caption: "Just words", width: null, height: null });
  assert.deepEqual(imageLabel(null), { caption: null, width: null, height: null });
  const sized = renderInline("![[pic.png|400]]");
  assert.match(sized, /<img class="att" data-file="pic.png" alt="pic.png" style="width:400px"/);
  assert.doesNotMatch(sized, /figure/);
  const both = renderInline("![[pic.png|400x300]]");
  assert.match(both, /style="width:400px;height:300px;object-fit:contain"/);
  const cap = renderInline('![[pic.png|A <b>cell</b> "x"|250]]');
  assert.match(cap, /<span class="figure" style="width:250px"><img class="att" data-file="pic.png" alt="A &lt;b&gt;cell/);
  assert.match(cap, /<span class="figure-caption">A &lt;b&gt;cell&lt;\/b&gt; &quot;x&quot;<\/span>/);
  assert.doesNotMatch(renderInline("![[pic.png|A cell]]", { captions: false }), /figure/);
  assert.match(renderInline("![[pic.png|A cell]]", { captions: false }), /alt="A cell"/);
  // Obsidian's size in a Markdown image's alt text.
  assert.match(renderInline("![Cat|300](https://example.org/c.png)"),
    /<span class="figure" style="width:300px"><img src="https:\/\/example.org\/c.png" alt="Cat" style="width:300px"/);
  // Sizes can't inject styles.
  assert.doesNotMatch(renderInline("![[pic.png|400;position:fixed]]"), /style="[^"]*position/);
});

test("PDF embeds", () => {
  assert.match(renderInline("![[paper.pdf]]"), /<span class="pdf-embed" data-file="paper.pdf" data-pdf-page="1">/);
  assert.match(renderInline("![[paper.pdf#page=3]]"), /data-pdf-page="3"/);
  assert.match(renderInline("![[paper.pdf#page=2&height=500]]"), /data-pdf-page="2" data-height="500"/);
  assert.doesNotMatch(renderInline("![[paper.pdf]]", { pdfInline: false }), /pdf-embed/);
  assert.match(renderInline("![[paper.pdf]]", { pdfInline: false }), /class="att-link"/);
  assert.match(renderInline("[[paper.pdf]]"), /class="att-link"/);
});

test("page and section embeds: framed, depth limited, loops shown as links", () => {
  const pages = {
    a: { title: "A", markdown: "Text of A\n\n![[B]]" },
    b: { title: "B", markdown: "## One\nfirst\n### Sub\nsub text\n## Two\nsecond\n- [ ] task in B" },
    loop: { title: "Loop", markdown: "I embed myself: \n\n![[Loop]]" },
    d1: { title: "D1", markdown: "![[D2]]" },
    d2: { title: "D2", markdown: "![[D3]]" },
    d3: { title: "D3", markdown: "![[D4]]" },
    d4: { title: "D4", markdown: "deep" },
  };
  const find = (t) => Object.values(pages).find((p) => p.title.toLowerCase() === t.toLowerCase()) ?? null;
  const opts = { resolve: (t) => ({ title: find(t)?.title ?? t, exists: Boolean(find(t)) }), embed: find };
  const html = renderMarkdown("Intro\n![[A]]\n\n![[B#One]]\n\n![[Missing]]", { ...opts, page: { title: "Top" } });
  assert.match(html, /<p data-line="0">Intro<\/p>/);
  assert.match(html, /<div class="page-embed" data-embed="A"><div class="page-embed-head"><a class="wl"[^>]*>A<\/a>/);
  assert.match(html, /Text of A/);
  assert.match(html, /<div class="page-embed" data-embed="B" data-heading="one">/);
  const section = html.slice(html.indexOf('data-heading="one">'));
  assert.match(section, /first[\s\S]*sub text/);
  assert.doesNotMatch(section.slice(0, section.indexOf("page-embed missing")), /second/);
  assert.match(html, /page-embed missing/);
  // Embedded headings get no ids (the page's own headings keep theirs).
  assert.doesNotMatch(html, /<h2 id=/);
  // Loops: a page embedding itself shows a link.
  const loop = renderMarkdown(pages.loop.markdown, { ...opts, page: { title: "Loop" } });
  assert.match(loop, /page-embed stopped" title="Loop: embeds itself"/);
  // Depth ≤ 3.
  const deep = renderMarkdown("![[D1]]", { ...opts, page: { title: "Top" } });
  assert.equal((deep.match(/class="page-embed" data-embed/g) ?? []).length, 3);
  assert.match(deep, /D4: embedded too deep/);
  assert.doesNotMatch(deep, /deep<\/p>/);
  // Embedded tasks know their page and their line in it.
  const tasks = renderMarkdown("![[B#Two]]", { ...opts, tasks: true });
  assert.match(tasks, /data-line="6" data-task-page="B"/);
  // An embed in the middle of a sentence stays an inline link; without `embed` too.
  assert.match(renderMarkdown("See ![[A]] here", opts), /<a class="wl embed"/);
  assert.match(renderMarkdown("![[A]]"), /<a class="wl embed"/);
});

test("sections and headings", () => {
  const body = "# Title\nintro\n## Methods\nm1\n```\n## not a heading\n```\n### Sub\ns\n## Results\nr";
  assert.deepEqual(sectionOf(body, "Methods"), { text: "## Methods\nm1\n```\n## not a heading\n```\n### Sub\ns", start: 2 });
  assert.equal(sectionOf(body, "nope"), null);
  assert.deepEqual(headingsOf(body).map((h) => `${h.level}:${h.text}:${h.id}:${h.line}`),
    ["1:Title:title:0", "2:Methods:methods:2", "3:Sub:sub:7", "2:Results:results:9"]);
  assert.equal(headingsOf("## About [[Mouse|mice]]")[0].text, "About mice");
});

test("tasks: checkboxes carry their line, clickable when asked, and toggle the right line", () => {
  const body = "Intro\n- [ ] one\n- [x] two\n  - [ ] nested\n\n> - [ ] quoted\n\n```\n- [ ] code\n```\n1. [ ] numbered";
  const html = renderMarkdown(body, { tasks: true });
  const lines = [...html.matchAll(/task-box" data-line="(\d+)"(?: data-task-page="[^"]*")?( disabled)?( checked)?>/g)]
    .map((m) => `${m[1]}${m[3] ? "x" : ""}`);
  assert.deepEqual(lines, ["1", "2x", "3", "5", "10"]);
  assert.doesNotMatch(html, /disabled/);
  assert.match(renderMarkdown(body), /disabled/);
  assert.match(html, /<li class="task done" data-line="2">/);
  const md = `---\ntype: Note\n---\n\n${body}`;
  assert.equal(bodyOffset(md), 4);
  assert.match(toggleTask(md, 1), /- \[x\] one/);
  assert.match(toggleTask(md, 2), /- \[ \] two/);
  assert.match(toggleTask(md, 3), / {2}- \[x\] nested/);
  assert.match(toggleTask(md, 5), /> - \[x\] quoted/);
  assert.match(toggleTask(md, 10), /1\. \[x\] numbered/);
  assert.equal(toggleTask(md, 0), null);
  assert.equal(toggleTask(body, 1, true), body.replace("- [ ] one", "- [x] one"));
});

test("callouts fold", () => {
  assert.match(renderMarkdown("> [!tip]- Hidden\n> body"), /<details class="callout" data-callout="tip" data-line="0">/);
  assert.match(renderMarkdown("> [!tip]+ Shown\n> body"), /<details class="callout" data-callout="tip" data-line="0" open>/);
  assert.match(renderMarkdown("> [!tip] Plain\n> body"), /<div class="callout" data-callout="tip" data-line="0">/);
});

test("code blocks use the highlighter when there is one", () => {
  const highlight = (code, lang) => (lang === "js" ? `<span class="tok">${code.length}</span>` : null);
  assert.match(renderMarkdown("```js\nlet a = 1;\n```", { highlight }), /<pre data-lang="js" data-line="0"><code class="language-js"><span class="tok">10/);
  assert.match(renderMarkdown("```py\n<x>\n```", { highlight }), /<code class="language-py">&lt;x&gt;<\/code>/);
  assert.match(renderMarkdown("```\n<x>\n```", { highlight }), /<pre data-line="0"><code>&lt;x&gt;/);
  assert.match(renderMarkdown("```js\nx\n```", { highlight: () => { throw new Error("no"); } }), />x<\/code>/);
});

test("[[#Heading]] links to this page", () => {
  assert.match(renderInline("[[#Methods]]", { page: { title: "Exp" } }),
    /<a class="wl" href="#" data-page="Exp" data-heading="methods"[^>]*>Methods<\/a>/);
  assert.equal(renderInline("[[#Methods]]"), "[[#Methods]]");
});

test("blocks carry their line (opening a page at a line)", () => {
  const html = renderMarkdown("# T\n\npara\nmore\n\n- a\n- b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n> quote");
  assert.deepEqual([...html.matchAll(/<(\w+)[^>]*? data-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`),
    ["h1:0", "p:2", "li:5", "li:6", "div:8", "blockquote:12", "p:12"]);
});

test("lists can interrupt a paragraph", () => {
  assert.match(renderMarkdown("Text\n- [ ] task", { tasks: true }),
    /<p data-line="0">Text<\/p>\n<ul class="contains-task-list">/);
  assert.match(renderMarkdown("Year\n2024. was good"), /<p data-line="0">Year\n2024. was good<\/p>/);
});

test("word count", () => {
  const s = textStats("# Title\n\nOne **two** [[Three|three]] four.\n\n```\nnot counted\n```\n- [ ] five");
  assert.equal(s.words, 6);
  assert.equal(s.readingMinutes, 1);
  assert.equal(textStats("").readingMinutes, 0);
});

test("mentions: found outside links and code, linked one by one or all", () => {
  const md = "---\ntitle: Mouse\n---\n\nThe mouse and the [[Mouse]] and `Mouse` and Mice.\nMouse again; mousetrap no.";
  const found = findMentions(md, ["Mouse", "Mice"]);
  assert.deepEqual(found.map((m) => `${m.text}@${m.line}`), ["mouse@4", "Mice@4", "Mouse@5"]);
  const one = linkMentions(md, "Mouse", ["Mouse", "Mice"], 1);
  assert.equal(one.count, 1);
  assert.match(one.markdown, /and \[\[Mouse\|Mice\]\]\./);
  assert.match(one.markdown, /The mouse and/);
  const all = linkMentions(md, "Mouse", ["Mouse", "Mice"]);
  assert.equal(all.count, 3);
  assert.match(all.markdown, /The \[\[Mouse\|mouse\]\] and the \[\[Mouse\]\] and `Mouse` and \[\[Mouse\|Mice\]\]\.\n\[\[Mouse\]\] again; mousetrap no\./);
  assert.match(all.markdown, /^---\ntitle: Mouse\n---/);
  assert.deepEqual(findMentions("See https://x.org/Mouse and [mouse](https://m.org)", ["Mouse"]), []);
});

test("backlink context", () => {
  const md = "---\norganism: \"[[Mouse]]\"\n---\n\nFirst line.\nWe used [[mouse|mice]] here.\n```\n[[Mouse]]\n```";
  assert.deepEqual(linkContexts(md, ["Mouse"]), [{ line: 1, text: "We used [[mouse|mice]] here." }]);
  assert.deepEqual(linkContexts("---\norganism: \"[[Mouse]]\"\n---\nx", ["Mouse"]),
    [{ line: -1, text: 'organism: "[[Mouse]]"' }]);
});

test("merge3: separate changes merge, the same lines conflict", () => {
  const base = "a\nb\nc\nd\ne";
  assert.deepEqual(merge3(base, "A\nb\nc\nd\ne", "a\nb\nc\nd\nE"), { text: "A\nb\nc\nd\nE", clean: true });
  assert.deepEqual(merge3(base, "a\nb\nc\nd\ne\nmine", "top\na\nb\nc\nd\ne"), { text: "top\na\nb\nc\nd\ne\nmine", clean: true });
  assert.deepEqual(merge3(base, "a\nB1\nc\nd\ne", "a\nB2\nc\nd\ne"), { text: "a\nB1\nc\nd\ne", clean: false });
  assert.deepEqual(merge3(base, "a\nX\nc\nd\ne", "a\nX\nc\nd\ne"), { text: "a\nX\nc\nd\ne", clean: true });
  assert.deepEqual(merge3(base, base, "z"), { text: "z", clean: true });
  assert.deepEqual(merge3(base, "z", base), { text: "z", clean: true });
  assert.equal(merge3(base, "a\nb\nnew1\nc\nd\ne", "a\nb\nnew2\nc\nd\ne").clean, false);
});
