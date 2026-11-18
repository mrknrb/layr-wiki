// Part E: import, export, public links and the AI's pure helpers (panels/io/convert.js, panels/ai/prompts.js,
// backend/io-tools.js) against an in-memory store and a fake Storage.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { createBackend } from "../backend/core.js";
import { copyRemoteImages, htmlToMarkdown } from "../backend/io-tools.js";
import {
  addRelated, addTags, applySuggestions, askPrompt, citedPages, cleanResult, clipPage, linkFirstMention,
  mentionedPages, parseJsonAnswer, pickPages, questionWords, readSuggestions,
} from "../panels/ai/prompts.js";
import {
  base64ToBytes, bytesToBase64, convertNotionMarkdown, csvToMarkdown, embeddedImages, exportDocument, markdownFiles,
  newSlug, notionLookups, parseCsv, parseShareHash, planNotion, projectRef, shareDoc, shareLink, shareObjectUrl,
  standaloneHtml, stripNotionId, zipStore,
} from "../panels/io/convert.js";
import { Wiki } from "../shared/wiki.js";
import { memoryAdapter } from "./memory.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const HEX = "0123456789abcdef0123456789abcdef";

function fakeStorage() {
  const objects = new Map();
  const fetch = async (url, { method, body } = {}) => {
    const key = url.split("/lf-wiki/")[1];
    const res = (status, data, text = "") => ({
      ok: status < 300, status, text: async () => text,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    });
    if (method === "POST") {
      objects.set(key, Buffer.from(body));
      return res(200, Buffer.alloc(0));
    }
    return objects.has(key) ? res(200, objects.get(key)) : res(400, null, '{"error":"not_found"}');
  };
  return { objects, fetch };
}

function setup() {
  const adapter = memoryAdapter();
  const backend = createBackend({
    adapter,
    session: async () => ({ url: "https://x.supabase.co", key: "anon", accessToken: "t", userId: "u1" }),
    settings: async () => ({ mirror: false, folder: "" }),
    device: "pc1",
  });
  const storage = fakeStorage();
  backend.files.fetch = storage.fetch;
  const panel = { "layr/caller": { kind: "panel", plugin: "wiki" } };
  return { adapter, backend, storage, call: (name, args) => backend.call(name, args, panel) };
}

// ---------- bytes and zips ----------

test("base64 both ways, and a stored zip any unzip reads", () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 251);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.deepEqual(base64ToBytes(`data:image/png;base64,${PNG}`).slice(0, 4), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const zip = zipStore([{ name: "Notes/Ünnep.md", data: "# hi\n" }, { name: "attachments/p.png", data: base64ToBytes(PNG) }]);
  const files = unzipSync(zip);
  assert.equal(new TextDecoder().decode(files["Notes/Ünnep.md"]), "# hi\n");
  assert.equal(files["attachments/p.png"].length, base64ToBytes(PNG).length);
  const md = markdownFiles([{ title: "A", folder: "", markdown: "x" }, { title: "B", folder: "F/G", markdown: "y" }],
    [{ name: "p.png", bytes: new Uint8Array([1]) }]);
  assert.deepEqual(md.map((f) => f.name), ["A.md", "F/G/B.md", "attachments/p.png"]);
});

// ---------- export ----------

test("export HTML: one file, anchors between exported pages, pictures inlined, other links plain", () => {
  const html = '<p>See <a class="wl" href="#" data-page="B &amp; C" title="B">B &amp; C</a> and ' +
    '<a class="wl missing" href="#" data-page="Nowhere" title="x">Nowhere</a> <a class="tag" href="#" data-tag="t">#t</a></p>' +
    '<p><img class="att" data-file="pic.png" alt="pic.png" src="blob:http://x/1"> <img class="att" data-file="gone.png">' +
    '<a class="att-link" href="#" data-file="a.pdf">📎 a.pdf</a></p>';
  assert.deepEqual(embeddedImages(html), ["pic.png", "gone.png"]);
  const doc = exportDocument({
    title: "Two pages",
    pages: [{ title: "A", html }, { title: "B & C", html: "<p>back to <a class=\"wl\" data-page=\"A\">A</a></p>" }],
    images: { "PIC.png": `data:image/png;base64,${PNG}` },
  });
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<style>[\s\S]*prefers-color-scheme: dark[\s\S]*@media print/);
  assert.match(doc, /<nav class="toc">.*<a href="#p-a">A<\/a>.*<a href="#p-b-c">B &amp; C<\/a>/);
  assert.match(doc, /<article id="p-a"><h1 class="page-title">A<\/h1>/);
  assert.match(doc, /<a class="wl" href="#p-b-c">B &amp; C<\/a>/);
  assert.match(doc, /<a class="wl" href="#p-a">A<\/a>/);
  assert.match(doc, /<span class="wl-out">Nowhere<\/span>/);
  assert.match(doc, /<span class="tag">#t<\/span>/);
  assert.match(doc, /<img class="att" alt="pic.png" src="data:image\/png;base64,/);
  assert.doesNotMatch(doc, /blob:/);
  assert.match(doc, /<span class="missing-image">\[picture: gone.png\]<\/span>/);
  assert.match(doc, /<span class="att-file">📎 a.pdf<\/span>/);
  assert.doesNotMatch(doc, /data-page|href="#"/);
  // An address for a page outside the export (a public page) opens in a new tab.
  const out = standaloneHtml('<a class="wl" data-page="X">X</a>', { anchors: new Map([["x", "https://v.io/#r/u/s"]]) });
  assert.equal(out, '<a class="wl" href="https://v.io/#r/u/s" target="_blank" rel="noopener">X</a>');
});

test("export tool: html, markdown zip and Word from titles; Word comes back as a .docx", async () => {
  const { call, backend } = setup();
  await backend.files.upload("pic.png", base64ToBytes(PNG));
  await call("create", { title: "Alpha", body: "Hello [[Beta]] ![[pic.png]]\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n" });
  await call("create", { title: "Beta", body: "Back to [[Alpha]]." });
  const html = await call("export", { format: "html", titles: ["Alpha", "Beta"] });
  const doc = new TextDecoder().decode(base64ToBytes(html.base64));
  assert.equal(html.mime, "text/html");
  assert.match(doc, /<a class="wl" href="#p-beta">Beta<\/a>/);
  assert.match(doc, /src="data:image\/png;base64,/);
  const md = await call("export", { format: "markdown", titles: ["Alpha"] });
  const files = unzipSync(base64ToBytes(md.base64));
  assert.deepEqual(Object.keys(files).sort(), ["Alpha.md", "attachments/pic.png"]);
  const docx = await call("export", { format: "docx", titles: ["Alpha"] });
  assert.equal(docx.name, "Alpha.docx");
  assert.ok(unzipSync(base64ToBytes(docx.base64))["word/document.xml"], "a .docx is a zip with word/document.xml");
});

// ---------- Word import ----------

test("Word import: a .docx made with html-to-docx comes back as Markdown, its picture an attachment", async () => {
  const { call, backend, storage } = setup();
  const htmlToDocx = (await import("html-to-docx")).default;
  const source = `<h1>Results</h1><p>Some <strong>bold</strong> text and <a href="https://example.org">a link</a>.</p>` +
    `<ul><li>first</li><li>second</li></ul><table><tr><td>Gene</td><td>Fold</td></tr><tr><td>TP53</td><td>2.1</td></tr>` +
    `</table><p><img src="data:image/png;base64,${PNG}" width="20" height="20"></p>`;
  const buffer = await htmlToDocx(source, null, { title: "t" });
  const result = await call("import_word", { base64: bytesToBase64(new Uint8Array(buffer)), name: "Lab report.docx",
    folder: "Imports" });
  assert.equal(result.title, "Lab report");
  assert.equal(result.pictures, 1);
  const wiki = await backend.getWiki();
  const page = wiki.find("Lab report");
  assert.equal(page.folder ?? "Imports", "Imports");
  assert.match(page.markdown, /^# Results$/m);
  assert.match(page.markdown, /\*\*bold\*\*/);
  assert.match(page.markdown, /\[a link\]\(https:\/\/example\.org\)/);
  assert.match(page.markdown, /^- first$/m);
  assert.match(page.markdown, /\| Gene \| Fold \|\n\| --- \| --- \|\n\| TP53 \| 2\.1 \|/);
  assert.match(page.markdown, /!\[\[Lab report 1\.png\]\]/);
  assert.equal(storage.objects.size, 1);
  // A second import of the same name gets a free title; parts sent ahead work like base64.
  const b64 = bytesToBase64(new Uint8Array(buffer));
  await call("upload_part", { id: "u1", index: 1, data: b64.slice(1000) });
  await call("upload_part", { id: "u1", index: 0, data: b64.slice(0, 1000) });
  const again = await call("import_word", { upload: "u1", name: "Lab report.docx" });
  assert.equal(again.title, "Lab report (2)");
  await assert.rejects(call("import_word", { upload: "u1", name: "x.docx" }), /upload is gone/);
});

test("Word HTML → Markdown: header rows, cells with paragraphs, list markers", async () => {
  const md = await htmlToMarkdown("<table><tr><td><p>A</p><p>a2</p></td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>" +
    "<ol><li>one</li><li>two</li></ol>");
  assert.match(md, /\| A a2 \| B \|/);
  assert.match(md, /^1\. one$/m);
});

// ---------- Notion ----------

test("Notion names: ids stripped from files and folders", () => {
  assert.equal(stripNotionId(`Project plan ${HEX}.md`), "Project plan.md");
  assert.equal(stripNotionId(`Project plan ${HEX}`), "Project plan");
  assert.equal(stripNotionId(`Tasks ${HEX}_all.csv`), "Tasks_all.csv");
  assert.equal(stripNotionId("image.png"), "image.png");
  assert.equal(stripNotionId(HEX), HEX);
});

test("Notion plan and links: folders kept, [[links]], pictures, databases as tables", () => {
  const paths = [
    `Export-abc/Home ${HEX}.md`,
    `Export-abc/Home ${HEX}/Child page ${HEX.replace("0", "1")}.md`,
    `Export-abc/Home ${HEX}/diagram.png`,
    `Export-abc/Home ${HEX}/Tasks ${HEX.replace("0", "2")}.csv`,
    `Export-abc/Home ${HEX}/Tasks ${HEX.replace("0", "2")}_all.csv`,
    `Export-abc/Home ${HEX}/Tasks ${HEX.replace("0", "2")}/Write intro ${HEX.replace("0", "3")}.md`,
  ];
  const plan = planNotion(paths, { taken: (t) => t === "Home", folder: "Notion" });
  assert.equal(plan.root, "Export-abc");
  const by = Object.fromEntries(plan.pages.map((p) => [p.title, p]));
  assert.deepEqual(Object.keys(by).sort(), ["Child page", "Home (2)", "Tasks", "Write intro"]);
  assert.equal(by["Home (2)"].folder, "Notion");
  assert.equal(by["Child page"].folder, "Notion/Home");
  assert.equal(by["Write intro"].folder, "Notion/Home/Tasks");
  assert.equal(by.Tasks.kind, "csv");
  assert.match(by.Tasks.path, /_all\.csv$/);
  assert.deepEqual(plan.files.map((f) => f.name), ["diagram.png"]);

  const uploaded = new Map([[`export-abc/home ${HEX}/diagram.png`, "diagram (2).png"]]);
  const { titleOf, fileOf } = notionLookups(plan, uploaded);
  const md = `# Home\n\nSee [Child page](Home%20${HEX}/Child%20page%20${HEX.replace("0", "1")}.md) and ` +
    `[the kid](Home%20${HEX}/Child%20page%20${HEX.replace("0", "1")}.md), ` +
    `[tasks](Home%20${HEX}/Tasks%20${HEX.replace("0", "2")}.csv), [web](https://notion.so/x).\n\n` +
    `![](Home%20${HEX}/diagram.png)\n\n\`\`\`\n[keep](Home%20${HEX}/diagram.png)\n\`\`\`\n\n<aside>\n💡 Remember\n</aside>\n`;
  const out = convertNotionMarkdown(md, { path: `Export-abc/Home ${HEX}.md`, title: "Home (2)", titleOf, fileOf });
  assert.doesNotMatch(out, /^# Home/m);
  assert.match(out, /See \[\[Child page\]\] and \[\[Child page\|the kid\]\], \[\[Tasks\]\], \[web\]\(https:\/\/notion\.so\/x\)/);
  assert.match(out, /^!\[\[diagram \(2\)\.png\]\]$/m);
  assert.match(out, /\[keep\]\(Home%20/, "code blocks are left alone");
  assert.match(out, /> \[!note\]\n> 💡 Remember/);
  // A row page links back up with ../
  const child = convertNotionMarkdown(`[Home](../Home%20${HEX}.md)`, { path: `Export-abc/Home ${HEX}/Child page ${HEX}.md`,
    titleOf, fileOf });
  assert.equal(child, "[[Home (2)|Home]]\n");
});

test("CSV: quoted cells, and the first column linked to row pages", () => {
  assert.deepEqual(parseCsv(String.fromCharCode(0xfeff) + 'Name,Note\n"A, b","say ""hi""\nthere"\n\n'), [["Name", "Note"], ["A, b", 'say "hi"\nthere']]);
  const md = csvToMarkdown("Name,Status\nWrite intro,Done\nOther,|x|\n", { linkOf: (c) => (c === "Write intro" ? "Write intro" : null) });
  assert.equal(md, "| Name | Status |\n| --- | --- |\n| [[Write intro]] | Done |\n| Other | \\|x\\| |");
});

test("import_notion: a zip (with a zip inside, as Notion makes big ones) becomes pages and attachments", async () => {
  const { call, backend, storage } = setup();
  const inner = zipSync({
    [`Home ${HEX}.md`]: strToU8(`# Home\n\nGo to [Child](Home%20${HEX}/Child%20${HEX}.md).\n\n![](Home%20${HEX}/pic.png)\n`),
    [`Home ${HEX}/Child ${HEX}.md`]: strToU8(`# Child\n\nBack [Home](../Home%20${HEX}.md)\n`),
    [`Home ${HEX}/pic.png`]: base64ToBytes(PNG),
  });
  const outer = zipSync({ "Export-1.zip": inner });
  const r = await call("import_notion", { base64: bytesToBase64(outer), folder: "Notion" });
  assert.equal(r.created, 2);
  assert.equal(r.attachments, 1);
  assert.equal(storage.objects.size, 1);
  const wiki = await backend.getWiki();
  assert.equal(wiki.find("Home").markdown, "Go to [[Child]].\n\n![[pic.png]]\n");
  assert.equal(wiki.find("Child").markdown, "Back [[Home]]\n");
  assert.equal(wiki.find("Child").folder ?? "Notion/Home", "Notion/Home");
  await assert.rejects(call("import_notion", { base64: bytesToBase64(zipSync({ "a.txt": strToU8("x") })) }), /No Notion pages/);
});

test("import_notion: an unpacked folder on this PC", async () => {
  const { call, backend } = setup();
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-notion-"));
  try {
    await mkdir(path.join(dir, `Top ${HEX}`));
    await writeFile(path.join(dir, `Top ${HEX}.md`), `# Top\n\n[Sub](Top%20${HEX}/Sub%20${HEX}.md)\n`);
    await writeFile(path.join(dir, `Top ${HEX}`, `Sub ${HEX}.md`), "# Sub\n\ntext\n");
    const r = await call("import_notion", { path: dir });
    assert.equal(r.created, 2);
    assert.equal((await backend.getWiki()).find("Top").markdown, "[[Sub]]\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- public links ----------

test("share: slugs, links, the hash the viewer reads, and the JSON shape", () => {
  const s = newSlug();
  assert.match(s, /^[A-Za-z0-9]{24}$/);
  assert.notEqual(newSlug(), s);
  assert.equal(projectRef("https://tirznddjqwrovpvasgpn.supabase.co"), "tirznddjqwrovpvasgpn");
  const uid = "6b2c1f0e-1234-4abc-9def-0123456789ab";
  const link = shareLink("https://me.github.io/wiki-share/#old", { ref: "abcdefghij", uid, slug: s });
  assert.equal(link, `https://me.github.io/wiki-share/#abcdefghij/${uid}/${s}`);
  assert.equal(shareLink("", { ref: "a", uid, slug: s }), null);
  assert.deepEqual(parseShareHash(new URL(link).hash), { ref: "abcdefghij", uid, slug: s });
  assert.equal(parseShareHash("#abc/../x"), null);
  assert.equal(parseShareHash(`#abcdefghij/${uid}/short`), null);
  assert.equal(shareObjectUrl("abcdefghij", uid, s),
    `https://abcdefghij.supabase.co/storage/v1/object/public/lf-wiki-shares/${uid}/${s}.json`);
  const doc = shareDoc({ title: "T", html: "<p>x</p>", images: { "a.png": `data:image/png;base64,${PNG}`,
    "evil.png": "javascript:alert(1)" }, updated: 5, published: 7 });
  assert.deepEqual(Object.keys(doc).sort(), ["css", "generator", "html", "images", "published", "title", "updated", "v"]);
  assert.equal(doc.v, 1);
  assert.deepEqual(Object.keys(doc.images), ["a.png"]);
  assert.equal(doc.updated, 5);
  assert.match(doc.css, /--fg/);
});

// ---------- AI helpers ----------

async function smallWiki() {
  const wiki = new Wiki(memoryAdapter());
  await wiki.load();
  await wiki.create({ title: "TP53", markdown: "---\naliases: [p53]\n---\nTumour suppressor. Binds [[MDM2]].\n" });
  await wiki.create({ title: "MDM2", markdown: "E3 ligase that degrades p53.\n" });
  await wiki.create({ title: "Western blot", markdown: "A method. We used it for TP53 levels.\n" });
  await wiki.create({ title: "Cooking", markdown: "Nothing about genes.\n" });
  return wiki;
}

test("Ask: question words, the pages picked, the prompt, the pages cited", async () => {
  const wiki = await smallWiki();
  assert.deepEqual(questionWords("What does the p53 protein do in the cell?"), ["p53", "protein", "cell"]);
  const picked = pickPages(wiki, "What regulates p53?", { max: 3 });
  assert.equal(picked[0].page.title, "TP53");
  assert.ok(picked.some((p) => p.page.title === "MDM2"));
  assert.ok(!picked.some((p) => p.page.title === "Cooking"));
  const open = wiki.find("Western blot");
  const withOpen = pickPages(wiki, "how?", { open, max: 2 });
  assert.equal(withOpen[0].page.title, "Western blot");
  const tiny = pickPages(wiki, "p53 MDM2", { budget: 1000, perPage: 500 });
  assert.ok(tiny.reduce((n, p) => n + p.text.length, 0) <= 1100);
  const prompt = askPrompt({ question: "Why?", pages: picked, history: [{ role: "user", text: "Hi" }, { role: "ai", text: "Hello" }] });
  assert.match(prompt, /<page title="TP53">\n---/);
  assert.match(prompt, /User: Hi\n\nYou: Hello/);
  assert.match(prompt, /Question: Why\?$/);
  assert.deepEqual(citedPages(wiki, "It is [[TP53]] and [[p53|the protein]], [[MDM2#Function]], [[Nope]].").map((p) => p.title),
    ["TP53", "MDM2"]);
});

test("AI results: fences and JSON read out of answers", () => {
  assert.equal(cleanResult("```markdown\nHello\n```"), "Hello");
  assert.equal(cleanResult("<text>\nHi\n</text>"), "Hi");
  assert.deepEqual(parseJsonAnswer('Sure:\n```json\n{"tags": ["a"]}\n```'), { tags: ["a"] });
  assert.deepEqual(parseJsonAnswer('{"links": []} and more'), { links: [] });
  assert.equal(parseJsonAnswer("no json"), null);
});

test("Suggestions: mentioned pages, linking the first plain mention, tags, See also", async () => {
  const wiki = await smallWiki();
  const blot = wiki.find("Western blot");
  assert.deepEqual(mentionedPages(wiki, blot).map((m) => [m.page.title, m.name]), [["TP53", "TP53"]]);
  assert.deepEqual(mentionedPages(wiki, wiki.find("MDM2")).map((m) => [m.page.title, m.name]), [["TP53", "p53"]]);
  const md = "---\ntags: [lab]\n---\n# p53 notes\n\nThe `p53` code, [[Other|p53]] link, then p53 protein and p53 again.\n";
  const linked = linkFirstMention(md, "p53", "TP53");
  assert.equal(linked, "---\ntags: [lab]\n---\n# p53 notes\n\nThe `p53` code, [[Other|p53]] link, then [[TP53|p53]] protein and p53 again.\n");
  assert.equal(linkFirstMention("Nothing here", "p53", "TP53"), "Nothing here");
  assert.match(addTags(md, ["#Lab", "cell cycle"]), /tags:\n  - lab\n  - cell-cycle\n/);
  assert.doesNotMatch(addTags(md, ["LAB"]), /LAB/);
  assert.equal(addRelated("Text\n", ["A", "B"]), "Text\n\n## See also\n\n- [[A]]\n- [[B]]\n");
  assert.equal(addRelated("Text\n\n## See also\n\n- [[A]]\n\n## Notes\n\nx\n", ["B"]),
    "Text\n\n## See also\n\n- [[A]]\n- [[B]]\n\n## Notes\n\nx\n");
  const s = readSuggestions(wiki, blot, '{"links": [{"title": "mdm2", "why": "related"}, {"title": "Made up"}, ' +
    '{"title": "Western blot"}], "tags": ["#Method", "lab work", "method"]}');
  assert.deepEqual(s.links.map((l) => l.page.title), ["MDM2"]);
  assert.deepEqual(s.tags, ["method", "lab-work"]);
  const applied = applySuggestions(blot.markdown, { mentioned: [{ title: "TP53", name: "TP53" }], related: ["MDM2"], tags: ["method"] });
  assert.match(applied, /^---\ntags:/);
  assert.match(applied, /for \[\[TP53\]\] levels/);
  assert.match(applied, /## See also\n\n- \[\[MDM2\]\]/);
});

test("Clipper: title, source and clipped properties; remote pictures as links or attachments", async () => {
  const page = clipPage({ title: "A: B / C", url: "https://ex.org/a", markdown: "Hi ![cat](https://ex.org/c.png)\n",
    date: new Date("2026-11-18T10:00:00Z") });
  assert.equal(page.title, "A- B - C");
  assert.match(page.markdown, /^---\nsource: "?https:\/\/ex\.org\/a"?\nclipped: "?2026-11-18"?\n---/);
  assert.match(page.markdown, /\[Picture: cat\]\(https:\/\/ex\.org\/c\.png\)/);
  const { backend } = setup();
  const fetchImpl = async (url) => ({
    ok: !url.includes("bad"),
    headers: new Map([["content-type", url.includes("txt") ? "text/plain" : "image/png"]]),
    arrayBuffer: async () => base64ToBytes(PNG).buffer,
  });
  const r = await copyRemoteImages("![a](https://x.org/img/cat.png) ![b](https://x.org/bad.png) ![c](https://x.org/t.txt)",
    { files: backend.files, fetchImpl });
  assert.equal(r.copied, 1);
  assert.equal(r.failed, 2);
  assert.equal(r.markdown, "![[cat.png]] [Picture: b](https://x.org/bad.png) [Picture: c](https://x.org/t.txt)");
});

test("the share viewer page is one file with no outside loads and a strict policy", async () => {
  const html = await readFile(new URL("../share/index.html", import.meta.url), "utf8");
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(html, /<(script|link|img)[^>]+(src|href)="https?:/i);
  assert.ok(html.includes('setAttribute("sandbox", "allow-same-origin allow-popups'), "the page shows in a sandbox");
  assert.doesNotMatch(html, /"sandbox", "[^"]*allow-scripts/);
});

test("publish and unpublish (agents): the JSON in the public bucket, the record, the link", async () => {
  const { call, adapter, backend } = setup();
  const shares = new Map();
  const files = backend.files.fetch;
  backend.files.fetch = async (url, opts = {}) => {
    if (!url.includes("/lf-wiki-shares/")) return files(url, opts);
    const key = url.split("/lf-wiki-shares/")[1];
    if (opts.method === "POST") shares.set(key, { body: new TextDecoder().decode(opts.body), headers: opts.headers });
    if (opts.method === "DELETE") shares.delete(key);
    return { ok: true, status: 200, text: async () => "" };
  };
  backend.files.session = async () => ({ url: "https://abcdefghij.supabase.co", key: "anon", accessToken: "t",
    userId: "6b2c1f0e-1234-4abc-9def-0123456789ab" });
  await call("create", { title: "Open notes", body: "Hello [[Secret]]." });
  await call("create", { title: "Secret", body: "private" });
  await assert.rejects(call("publish", { title: "Open notes" }), /share viewer/);
  await adapter.dataSet("settings", { shareViewer: "https://me.github.io/share/" });
  const text = await call("publish", { title: "Open notes" });
  const m = /Published \[\[Open notes\]\]: (https:\/\/me\.github\.io\/share\/#abcdefghij\/6b2c1f0e-[^/]+\/([A-Za-z0-9]{24}))$/.exec(text);
  assert.ok(m, text);
  const [key, obj] = [...shares][0];
  assert.equal(key, `6b2c1f0e-1234-4abc-9def-0123456789ab/${m[2]}.json`);
  assert.equal(obj.headers["x-upsert"], "true");
  const doc = JSON.parse(obj.body);
  assert.equal(doc.title, "Open notes");
  assert.match(doc.html, /Hello <span class="wl-out">Secret<\/span>/, "links to private pages are plain text");
  const wiki = await backend.getWiki();
  const record = await adapter.dataGet(`share/${wiki.find("Open notes").id}`);
  assert.equal(record.slug, m[2]);
  assert.match(await call("publish", { title: "Open notes" }), /^Updated/);
  assert.equal(shares.size, 1, "republishing replaces the same object");
  assert.match(await call("unpublish", { title: "Open notes" }), /private again/);
  assert.equal(shares.size, 0);
  assert.equal(await adapter.dataGet(`share/${wiki.find("Open notes").id}`), null);
});
