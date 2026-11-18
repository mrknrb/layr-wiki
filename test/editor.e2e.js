// The editor in headless Chromium (no layr needed): serves the repository's root, opens panels/editor/dev.html (a
// stand-in app and a sample page) and drives it: live preview, revealing syntax, commands and toggles, completion, the
// slash menu, the table editor, checkboxes, link clicks, image resizing, source mode, light and dark, PC and phone.
// Screenshots go to screenshots/editor-*.png. Run: node test/editor.e2e.js (Playwright from PWTOOLS or
// C:/Users/mrknr/pwtools).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, "..");
const root = join(plugin, "..", "..");
const require = createRequire(join(process.env.PWTOOLS ?? "C:/Users/mrknr/pwtools", "package.json"));
const { chromium } = require("playwright");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/plugins/wiki/panels/editor/dev.html`;
const shots = join(plugin, "screenshots");

const browser = await chromium.launch();
const errors = [];
let failed = 0;
async function open(params = "", viewport = { width: 1100, height: 900 }) {
  const page = await browser.newPage({ viewport, hasTouch: viewport.width < 700 });
  page.on("pageerror", (e) => errors.push(`${params}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${params}: ${m.text()}`));
  await page.goto(`${base}?${params}`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  return page;
}
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`);
  }
}
const text = (page) => page.evaluate(() => window.ed.getText());
const setDoc = (page, doc, anchor = null) => page.evaluate(([d, a]) => {
  window.ed.setText(d, { keepCursor: false });
  window.ed.focus();
  if (a !== null) window.ed.view.dispatch({ selection: { anchor: a } });
}, [doc, anchor]);
const select = (page, from, to = from) => page.evaluate(([a, b]) => {
  window.ed.focus();
  window.ed.view.dispatch({ selection: { anchor: a, head: b }, userEvent: "select" });
}, [from, to]);

try {
  const page = await open("theme=dark");
  await step("renders the sample, marks hidden", async () => {
    const content = await page.locator(".cm-content").innerText();
    assert.ok(!content.includes("**light**"), "bold marks hidden");
    assert.ok(!content.includes("[[Photosynthesis]]"), "link marks hidden");
    assert.ok(content.includes("the Calvin cycle"), "label shown");
    assert.equal(await page.locator(".cm-frontmatter-fold").count(), 1, "properties folded");

    assert.equal(await page.locator(".cm-task-box").count(), 2, "checkboxes");
    assert.ok(await page.locator(".cm-callout-head").count() >= 2, "callouts");
    assert.equal(await page.locator(".cm-wikilink.cm-missing").count(), 1, "missing link");
    // The lower part (CodeMirror draws only what is near the screen).
    await page.evaluate(() => window.ed.scrollToHeading("A table"));
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".cm-table-widget table").count(), 1, "table widget");
    await page.evaluate(() => window.ed.view.scrollDOM.scrollTo(0, 1100));
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".cm-math-block").count(), 1, "math block");
    assert.ok(await page.locator(".cm-codeblock .tok-keyword").count() >= 1, "code highlighted");
    await page.waitForSelector(".cm-image img[src^='blob:']", { timeout: 5000 });
    assert.equal(await page.locator(".cm-file-card").count(), 1, "pdf card");
    assert.ok(await page.locator(".cm-embed-body h2, .cm-embed-body p").count() >= 1, "page embed rendered");
  });
  await page.screenshot({ path: join(shots, "editor-pc-dark-lower.png") });
  await page.evaluate(() => window.ed.view.scrollDOM.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, "editor-pc-dark.png") });

  await step("the line being edited shows its marks", async () => {
    const doc = await text(page);
    const at = doc.indexOf("**light**") + 3;
    await select(page, at);
    await page.waitForTimeout(100);
    const line = await page.locator(".cm-activeLine, .cm-line").filter({ hasText: "Plants turn" }).first().innerText();
    assert.ok(line.includes("**light**"), line);
  });
  await page.screenshot({ path: join(shots, "editor-pc-dark-editing.png") });

  await step("bold toggles on and off", async () => {
    await setDoc(page, "one two three", 5);
    await page.keyboard.press("Control+b");
    assert.equal(await text(page), "one **two** three");
    await page.keyboard.press("Control+b");
    assert.equal(await text(page), "one two three");
  });
  await step("colour and highlight from the palette, then removed", async () => {
    await setDoc(page, "paint me");
    await select(page, 0, 5);
    await page.evaluate(() => window.ed.exec("color", "#e03e3e"));
    assert.equal(await text(page), '<span style="color:#e03e3e">paint</span> me');
    await page.evaluate(() => window.ed.exec("color", null));
    assert.equal(await text(page), "paint me");
    await select(page, 6, 8);
    await page.evaluate(() => window.ed.exec("highlight", "#0f7b6c"));
    assert.equal(await text(page), 'paint <mark style="background:#0f7b6c">me</mark>');
    await page.evaluate(() => window.ed.exec("highlight", null));
    assert.equal(await text(page), "paint me");
  });
  await step("headings with Ctrl+2, lists continue with Enter, empty item ends", async () => {
    await setDoc(page, "Title", 2);
    await page.keyboard.press("Control+2");
    assert.equal(await text(page), "## Title");
    await setDoc(page, "- [x] done", 10);
    await page.keyboard.press("Enter");
    await page.keyboard.type("next");
    assert.equal(await text(page), "- [x] done\n- [ ] next");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    assert.equal(await text(page), "- [x] done\n- [ ] next\n");
    await setDoc(page, "1. a", 4);
    await page.keyboard.press("Enter");
    assert.equal(await text(page), "1. a\n2. ");
  });
  await step("Tab indents a list item, Ctrl+Enter ticks a task", async () => {
    await setDoc(page, "- a\n- b", 7);
    await page.keyboard.press("Tab");
    assert.equal(await text(page), "- a\n    - b");
    await setDoc(page, "- [ ] x", 7);
    await page.keyboard.press("Control+Enter");
    assert.equal(await text(page), "- [x] x");
  });
  await step("a click on a checkbox ticks it", async () => {
    await setDoc(page, "intro\n\n- [ ] water\n- [ ] feed");
    await page.evaluate(() => window.ed.view.contentDOM.blur());
    await page.locator(".cm-task-box").first().click();
    assert.equal(await text(page), "intro\n\n- [x] water\n- [ ] feed");
  });
  await step("[[ completes titles (fuzzy) and headings", async () => {
    await setDoc(page, "See ", 4);
    await page.keyboard.type("[[phts");
    await page.waitForSelector(".cm-tooltip-autocomplete li");
    await page.waitForTimeout(150);
    const first = await page.locator(".cm-tooltip-autocomplete li").first().innerText();
    assert.ok(first.includes("Photosynthesis"), first);
    await page.keyboard.press("Enter");
    assert.equal(await text(page), "See [[Photosynthesis]]");
    await setDoc(page, "See [[Photosynthesis#", 21);
    await page.evaluate(() => import("../../vendor/editor.js").then((m) => m.startCompletion(window.ed.view)));
    await page.waitForSelector(".cm-tooltip-autocomplete li");
    await page.keyboard.type("calv");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    assert.equal(await text(page), "See [[Photosynthesis#Calvin cycle]]");
  });
  await step("# completes tags", async () => {
    await setDoc(page, "tagged ", 7);
    await page.keyboard.type("#bio");
    await page.waitForSelector(".cm-tooltip-autocomplete li");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    assert.equal(await text(page), "tagged #biology");
  });
  await step("/ opens the slash menu; Table inserts a table", async () => {
    await setDoc(page, "", 0);
    await page.keyboard.type("/");
    await page.waitForSelector(".cm-tooltip-autocomplete li");
    await page.screenshot({ path: join(shots, "editor-slash-menu.png") });
    await page.keyboard.type("tabl");
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    const t = await text(page);
    assert.ok(t.startsWith("| Column 1 | Column 2 | Column 3 |\n| -------- |"), t);
  });
  await step("the table editor: edit a cell, add a row and a column", async () => {
    await setDoc(page, "Intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter");
    await page.evaluate(() => window.ed.view.dispatch({ selection: { anchor: 0 } }));
    await page.waitForSelector(".cm-table-widget td");
    await page.locator(".cm-table-widget td").first().click();
    await page.waitForSelector(".cm-table-input");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("one");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    assert.ok((await text(page)).includes("| one | 2   |"), await text(page));
    await page.waitForSelector(".cm-table-bar button");
    await page.screenshot({ path: join(shots, "editor-table-editing.png") });
    await page.locator('.cm-table-bar button[title="Insert a row below"]').click();
    await page.waitForTimeout(150);
    await page.locator('.cm-table-bar button[title="Insert a column to the right"]').click();
    await page.waitForTimeout(150);
    const t = await text(page);
    assert.equal(t.split("\n").filter((l) => l.startsWith("|")).length, 4, t);
    assert.ok(/^\| A +\| B +\| +\|$/m.test(t), t);
  });
  await step("a click on a formatted link opens it; Ctrl+click opens a new tab", async () => {
    await setDoc(page, "Go to [[Photosynthesis]] now.\n\nother line");
    await page.evaluate(() => window.ed.view.dispatch({ selection: { anchor: 40 } }));
    await page.locator(".cm-wikilink").first().click();
    await page.locator(".cm-wikilink").first().click({ modifiers: ["Control"] });
    const log = await page.evaluate(() => window.__log.filter((l) => l.startsWith("openPage")));
    assert.deepEqual(log.slice(-2), ['openPage Photosynthesis {"newTab":false}', 'openPage Photosynthesis {"newTab":true}']);
  });
  await step("dragging an image's corner writes its width", async () => {
    await setDoc(page, "![[leaf.png|A leaf|300]]\n\ntext");
    await page.evaluate(() => window.ed.view.dispatch({ selection: { anchor: 28 } }));
    await page.waitForSelector(".cm-image img[src^='blob:']");
    const fig = page.locator(".cm-image").first();
    await fig.hover();
    const box = await page.locator(".cm-image-resize").boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 105, box.y + 30, { steps: 5 });
    await page.mouse.up();
    const t = await text(page);
    assert.match(t, /^!\[\[leaf\.png\|A leaf\|4\d\d\]\]/, t);
  });
  await step("selection events carry a rect; stats count words", async () => {
    await setDoc(page, "# Title\n\nOne two three four.");
    await select(page, 9, 16);
    await page.waitForTimeout(100);
    const sel = await page.evaluate(() => window.__sel);
    assert.equal(sel.text, "One two");
    assert.ok(sel.rect && sel.rect.width > 10, JSON.stringify(sel.rect));
    const stats = await page.evaluate(() => window.ed.stats());
    assert.equal(stats.words, 5);
    assert.equal(stats.selection.words, 2);
  });
  await step("source mode shows the Markdown, live mode returns", async () => {
    await setDoc(page, "**b** [[Photosynthesis]]");
    await page.evaluate(() => window.ed.view.contentDOM.blur());
    await page.evaluate(() => window.ed.setMode("source"));
    assert.ok((await page.locator(".cm-content").innerText()).includes("**b** [[Photosynthesis]]"));
    await page.evaluate(() => window.ed.setMode("live"));
  });
  await step("settings apply live (line numbers, editor mode)", async () => {
    await page.evaluate(() => window.app.settings.set({ lineNumbers: true }));
    assert.equal(await page.locator(".cm-lineNumbers").count(), 1);
    await page.evaluate(() => window.app.settings.set({ lineNumbers: false, editorMode: "source" }));
    assert.equal(await page.evaluate(() => window.ed.mode()), "source");
    await page.evaluate(() => window.app.settings.set({ editorMode: "live" }));
  });
  await step("pasting HTML gives Markdown; pasting a picture uploads it and embeds it", async () => {
    await setDoc(page, "", 0);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/html", '<h2>Title</h2><p>Some <b>bold</b> and <a href="https://x.org">a link</a>.</p>' +
        "<ul><li>one</li><li>two</li></ul>");
      dt.setData("text/plain", "Title Some bold and a link. one two");
      window.ed.view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    });
    assert.equal(await text(page), "## Title\n\nSome **bold** and [a link](https://x.org).\n\n- one\n- two");
    await setDoc(page, "", 0);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
      window.ed.view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    });
    await page.waitForFunction(() => window.ed.getText().length > 0);
    assert.match(await text(page), /^!\[\[Pasted \d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.png\]\]$/);
  });
  await step("the slash menu inserts today's date", async () => {
    await setDoc(page, "", 0);
    await page.keyboard.type("/today");
    await page.waitForSelector(".cm-tooltip-autocomplete li");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    assert.match(await text(page), /^\d{4}-\d\d-\d\d$/);
  });
  await step("read-only: no typing, checkboxes stay", async () => {
    await setDoc(page, "intro\n\n- [ ] a");
    await page.evaluate(() => window.ed.setReadOnly(true));
    try {
      await page.locator(".cm-task-box").first().click();
      await page.evaluate(() => window.ed.exec("bold"));
      assert.equal(await text(page), "intro\n\n- [ ] a");
    } finally {
      await page.evaluate(() => window.ed.setReadOnly(false));
    }
  });
  await step("focus starts after the properties; scrollToHeading finds a heading", async () => {
    await page.evaluate(() => {
      window.ed.view.contentDOM.blur();
      window.ed.setText("---\ntype: x\n---\n# One\n\n## Two", { keepCursor: false });
      window.ed.focus();
    });
    assert.equal(await page.evaluate(() => window.ed.selection().from), 16);
    assert.equal(await page.locator(".cm-frontmatter-fold").count(), 1);
    assert.equal(await page.evaluate(() => window.ed.scrollToHeading("two")), true);
    assert.equal(await page.evaluate(() => window.ed.view.state.doc.lineAt(window.ed.selection().from).text), "## Two");
  });
  await step("Ctrl+F opens the search panel", async () => {
    await page.evaluate(() => window.ed.focus());
    await page.keyboard.press("Control+h");
    await page.waitForSelector(".cm-search");
    await page.screenshot({ path: join(shots, "editor-search.png") });
    await page.keyboard.press("Escape");
  });
  await page.close();

  for (const [name, params, viewport] of [
    ["pc-light", "theme=light", { width: 1100, height: 900 }],
    ["phone-dark", "theme=dark", { width: 390, height: 844 }],
    ["phone-light", "theme=light", { width: 390, height: 844 }],
  ]) {
    const p = await open(params, viewport);
    await p.screenshot({ path: join(shots, `editor-${name}.png`) });
    if (name === "pc-light") {
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.evaluate(() => window.ed.view.scrollDOM.scrollTo(0, 700));
      await p.waitForTimeout(300);
      await p.screenshot({ path: join(shots, "editor-pc-light-lower.png") });
      await p.locator(".cm-wiki-tool[data-cmd=color]").click();
      await p.waitForSelector(".cm-wiki-popover");
      await p.screenshot({ path: join(shots, "editor-color-menu.png") });
    }
    if (name === "phone-dark") {
      await step("phone: the toolbar floats at the bottom", async () => {
        const bar = await p.locator(".cm-wiki-toolbar").boundingBox();
        assert.ok(bar.y + bar.height >= 840, JSON.stringify(bar));
      });
      await p.evaluate(() => window.ed.view.scrollDOM.scrollTo(0, 900));
      await p.waitForTimeout(300);
      await p.screenshot({ path: join(shots, "editor-phone-dark-lower.png") });
    }
    await p.close();
  }
  const src = await open("theme=dark&mode=source");
  await src.screenshot({ path: join(shots, "editor-source-dark.png") });
  await src.close();
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  failed++;
  console.log(`FAIL page errors:\n  ${errors.join("\n  ")}`);
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
