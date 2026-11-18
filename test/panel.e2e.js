// The Wiki panel and backend through a real core, in headless Chromium. Starts `layr serve` (a copy of core's debug
// build) on a free port with a temporary home and this plugin linked, points the folder copy at a temporary folder,
// writes pages with the backend's tools (over /mcp), then drives the panel's frame: tabs (open, close, reorder, back
// and forward, restored after a reload), the file tree (folders, drag to move), search, tags, bookmarks, the quick
// switcher, the command palette, hotkeys (rebinding one), the Settings page (live Look settings), the trash, focus
// mode, the phone layout (drawers, the tab switcher, quick capture), light and dark. Screenshots go to screenshots/.
// Turns on developer mode in its temporary home (the plugin is a linked folder with a backend). Needs no sign-in:
// pages are local data until the core is signed in (attachments, which need it, are covered by backend.test.js).
//   cargo build -p layr_cli   (in core/), then:  node test/panel.e2e.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const CORE = join(PLUGIN, "..", "..", "core");
const SHOTS = join(PLUGIN, "screenshots");
const require = createRequire(join(process.env.PWTOOLS ?? "C:/Users/mrknr/pwtools", "package.json"));
const { chromium } = require("playwright");
mkdirSync(SHOTS, { recursive: true });

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}
const step = (text) => console.log(`- ${text}`);

// ---------- the core ----------

const port = await freePort();
const token = "e2e-" + Math.random().toString(36).slice(2);
const home = mkdtempSync(join(tmpdir(), "layr-wiki-e2e-"));
const folder = join(home, "vault");
const exe = join(home, process.platform === "win32" ? "layr.exe" : "layr");
copyFileSync(join(CORE, "target", "debug", process.platform === "win32" ? "layr.exe" : "layr"), exe);
const core = spawn(exe, ["serve", "--port", String(port), "--token", token, "--home", join(home, "home"), "--link",
  PLUGIN], {
  cwd: CORE,
  stdio: ["ignore", "pipe", "pipe"],
});
let coreLog = "";
core.stdout.on("data", (d) => (coreLog += d));
core.stderr.on("data", (d) => (coreLog += d));
console.log(`layr serve pid ${core.pid} on ${port}`);
let browser;
const cleanup = async () => {
  await browser?.close().catch(() => {});
  core.kill();
  await sleep(500);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // a file still held: the temp folder is cleaned later
  }
};
process.on("uncaughtException", async (error) => {
  console.log("FAIL", error.stack ?? error);
  console.log(coreLog.slice(-3000));
  await cleanup();
  process.exit(1);
});
process.on("unhandledRejection", (error) => process.emit("uncaughtException", error));

await until("layr serve", async () => fetch(`http://127.0.0.1:${port}/_layr/layr.js`).then((r) => r.ok, () => false),
  60000);

class Shell {
  constructor(url) {
    this.url = url;
    this.next = 1;
    this.pending = new Map();
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`Can't connect to ${this.url}`));
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result);
        }
      };
    });
  }
  call(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}
const shell = new Shell(`ws://127.0.0.1:${port}/_layr/ws?token=${token}`);
await shell.open();
// A linked folder with a backend runs only in developer mode (docs/ARCHITECTURE.md › Developer mode).
await shell.call("settings.set", { key: "developerMode", value: true });
await shell.call("settings.set", { key: "theme", value: { mode: "dark" } });
await shell.call("pluginSettings.set", { plugin: "wiki", id: "folder", value: folder });

const hub = new Client({ name: "wiki-e2e", version: "0.1.0" });
await hub.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
async function tool(name, args = {}) {
  const r = await hub.callTool({ name: `wiki__${name}`, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
}

// ---------- pages through the tools ----------

const tools = (await hub.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("wiki__"));
assert.ok(tools.includes("wiki__read") && tools.includes("wiki__create"), `tools: ${tools}`);
await tool("create", { title: "TP53", type: "Gene", properties: { aliases: ["p53"], symbol: "TP53" },
  body: "## Function\n\nA transcription factor that stops the cell cycle after DNA damage. Its level is kept low by " +
    "[[MDM2]]. #bio/genes\n\n> [!question] Does it act the same way in [[Mouse|mice]]?\n" });
await tool("create", { title: "MDM2", type: "Gene", body: "## Function\n\nAn E3 ubiquitin ligase that marks p53 for " +
  "degradation. See [[TP53#Function]]. #bio/genes\n" });
await tool("create", { title: "Western blot", type: "Method", body: "## Protocol\n\n1. SDS-PAGE\n2. Transfer\n3. " +
  "Antibody against TP53\n\n- [ ] order antibodies #lab\n" });
await tool("create", { title: "Home", body: "## Overview\n\nMy PhD: [[TP53]], [[MDM2]], [[Western blot]]. #phd\n" });
for (let i = 1; i <= 4; i++) await tool("create", { title: `Reading note ${i}`,
  body: `Notes on paper ${i}. #reading\n` });
assert.match(await tool("read", { title: "p53" }), /TP53/);
assert.match(await tool("search", { query: "ubiquitin" }), /MDM2/);

await until("the folder copy", () => existsSync(join(folder, "TP53.md")) && existsSync(join(folder, "Home.md")), 20000);
assert.match(readFileSync(join(folder, "TP53.md"), "utf8"), /^---\ntype: Gene\n/);

// ---------- the panel ----------

const { url } = await shell.call("panels.create", { plugin: "wiki", panel: "main", params: { page: "TP53" } });
browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// A part that isn't there (yet) 404s: that is allowed, other console errors aren't.
page.on("console",
  (m) => m.type() === "error" && !/404|Failed to load resource/.test(m.text()) && errors.push(m.text()));
await page.goto(url);
await page.waitForSelector(".wiki-bar");
const activeTab = () => page.textContent(".wiki-tab.active .wiki-tab-title");
const tabCount = () => page.locator(".wiki-tab").count();
// Commands may wait for a dialog: start them without waiting for them to finish.
const run = (id) => page.evaluate((c) => {
  window.wikiApp.commands.run(c).catch((e) => console.warn(e));
}, id);
const shot = async (name) => {
  await sleep(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

step("opened with a page param: the page is the tab");
await until("TP53 open", async () => (await activeTab()) === "TP53");
await page.waitForSelector('.wiki-view-root[data-view="page"]');
await page.waitForSelector('.wiki-tree-row.page[data-id]');
assert.ok((await page.locator(".wiki-tree-row.page").count()) >= 8, "the file tree lists the pages");
assert.equal(await page.locator(".wiki-tree-row.page.active").count(), 1, "the open page is marked in the tree");
await shot("page-dark");

step("a link opens in the tab; back and forward");
await page.click(".wiki-view a.wl[data-page='MDM2']");
await until("MDM2", async () => (await activeTab()) === "MDM2");
await page.click("#btnBack");
await until("back to TP53", async () => (await activeTab()) === "TP53");
await page.click("#btnForward");
await until("forward to MDM2", async () => (await activeTab()) === "MDM2");

step("Ctrl+click opens a new tab; middle-click on a tab closes it; Ctrl+W, Ctrl+Shift+T");
await page.click(".wiki-view a.wl[data-page^='TP53']", { modifiers: ["Control"] });
await until("two tabs", async () => (await tabCount()) === 2);
assert.equal(await activeTab(), "TP53");
await page.click(".wiki-tab:nth-child(1)", { button: "middle" });
await until("one tab", async () => (await tabCount()) === 1);
await page.keyboard.press("Control+t");
await until("new tab", async () => (await tabCount()) === 2);
assert.equal(await activeTab(), "Home");
await page.waitForSelector(".wiki-home .wiki-actions");
await shot("home-dark");
await page.locator(".wiki-view").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+w");
await until("closed by Ctrl+W", async () => (await tabCount()) === 1);
await page.keyboard.press("Control+Shift+T");
await until("reopened", async () => (await tabCount()) === 2);

step("quick switcher: fuzzy, Enter opens, Ctrl+Enter opens in a new tab");
await page.keyboard.press("Control+o");
await page.waitForSelector("#switcher .wiki-chooser-input");
await page.keyboard.type("wstn");
await until("Western blot first",
  async () => /Western blot/.test(await page.textContent("#switcher .wiki-chooser-row.active")));
await shot("switcher-dark");
await page.keyboard.press("Enter");
await until("Western blot open", async () => (await activeTab()) === "Western blot");
await page.keyboard.press("Control+o");
await page.keyboard.type("p53");
await until("alias match", async () => /TP53/.test(await page.textContent("#switcher .wiki-chooser-row.active")));
await page.keyboard.press("Control+Enter");
await until("TP53 in a new tab", async () => (await tabCount()) === 3 && (await activeTab()) === "TP53");

step("tabs reorder by dragging");
const before = await page.locator(".wiki-tab .wiki-tab-title").allTextContents();
await page.dragAndDrop(".wiki-tab:nth-child(3)", ".wiki-tab:nth-child(1)", { targetPosition: { x: 4, y: 10 } });
const after = await page.locator(".wiki-tab .wiki-tab-title").allTextContents();
assert.equal(after[0], before[2], `dragged: ${before} → ${after}`);

step("command palette");
await page.keyboard.press("Control+p");
await page.waitForSelector("#palette .wiki-chooser-row");
await page.keyboard.type("settings");
await shot("palette-dark");
await page.keyboard.press("Enter");
await page.waitForSelector(".wiki-settings");

step("settings: live Look");
await page.selectOption('.wiki-setting[data-setting="lineWidth"] select', "wide");
await until("line width var", async () => (await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue("--wiki-line-width"))).trim() === "960px");
await page.fill('.wiki-setting[data-setting="fontSize"] input', "18");
await page.press('.wiki-setting[data-setting="fontSize"] input', "Tab");
await until("font size var", async () => (await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue("--wiki-font-size"))).trim() === "18px");
await shot("settings-dark");
await page.selectOption('.wiki-setting[data-setting="theme"] select', "light");
await until("light theme", async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
await shot("settings-light-override");
await page.selectOption('.wiki-setting[data-setting="theme"] select', "layr");
await until("back to layr's theme",
  async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
const stored = await page.evaluate(() => window.wikiApp.wiki.a.dataGet("settings"));
assert.equal(stored.fontSize, 18, "settings are saved in the plugin's data");

step("hotkeys: rebind Go home to Ctrl+Shift+H and use it");
await page.click('.wiki-settings-nav-item[data-group="hotkeys"]');
await page.fill(".wiki-settings-body input[type=search]", "go home");
await page.click('.wiki-keychip[data-command="home"]');
await page.keyboard.press("Control+Shift+H");
await until("key saved",
  async () => /Ctrl\+Shift\+H/.test(await page.textContent('.wiki-keychip[data-command="home"]')));
await shot("hotkeys-dark");
await page.locator(".wiki-view").click({ position: { x: 600, y: 700 } });
await page.keyboard.press("Control+Shift+H");
await until("home by the new key", async () => (await activeTab()) === "Home");

step("search panel: words, #tag, type:");
await page.click('.wiki-side-tab[data-panel="search"]');
await page.fill("#searchInput", "ubiquitin");
await until("search result", async () => /MDM2/.test(await page.textContent(".wiki-side .wiki-results")));
assert.ok(await page.locator(".wiki-side .wiki-result-snippet mark").count() >= 1, "snippets mark the words");
await page.fill("#searchInput", "#bio");
await until("tag search", async () => (await page.locator(".wiki-side .wiki-result").count()) === 2);
await shot("search-dark");

step("tags panel: nested, click searches");
await page.click('.wiki-side-tab[data-panel="tags"]');
await page.waitForSelector('[data-tag-row="bio"]');
assert.match(await page.textContent('[data-tag-row="bio"]'), /bio\s*2/);
await page.click('[data-tag-row="reading"]');
await until("tag search from tags", async () => (await page.inputValue("#searchInput")) === "#reading");
await until("4 reading notes", async () => (await page.locator(".wiki-side .wiki-result").count()) === 4);

step("bookmarks: a page and a search, reorder");
await page.click(".wiki-side .wiki-result >> nth=0");
await page.waitForSelector('.wiki-view-root[data-view="page"]');
await run("bookmark");
await page.click('.wiki-side-tab[data-panel="search"]');
await page.fill("#searchInput", "#bio");
await sleep(300);
await page.click('.wiki-search-box button[title="Bookmark this search"]');
await page.click('.wiki-side-tab[data-panel="bookmarks"]');
await until("two bookmarks", async () => (await page.locator(".wiki-tree-row.mark").count()) === 2);
const marks = await page.locator(".wiki-tree-row.mark .wiki-tree-name").allTextContents();
await page.dragAndDrop(".wiki-tree-row.mark >> nth=1", ".wiki-tree-row.mark >> nth=0", { targetPosition: { x: 20,
  y: 2 } });
await until("bookmarks reordered", async () =>
  (await page.locator(".wiki-tree-row.mark .wiki-tree-name").first().textContent()) === marks[1]);
await shot("bookmarks-dark");

step("folders: new folder, drag a page into it, the tree shows it nested");
const hasFolders = await page.evaluate(() => typeof window.wikiApp.wiki.createFolder === "function");
if (hasFolders) {
  await page.click('.wiki-side-tab[data-panel="files"]');
  await run("new-folder");
  await page.waitForSelector(".wiki-modal input");
  await page.fill(".wiki-modal input", "Projects");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.wiki-tree-row.folder[data-folder="Projects"]');
  const mdm2 = await page.evaluate(() => window.wikiApp.wiki.resolve("MDM2").id);
  await page.dragAndDrop(`.wiki-tree-row.page[data-id="${mdm2}"]`, '.wiki-tree-row.folder[data-folder="Projects"]');
  await until("MDM2 moved",
    async () => (await page.evaluate(() => window.wikiApp.wiki.resolve("MDM2").folder)) === "Projects");
  await page.waitForSelector(`.wiki-tree-row.page[data-id="${mdm2}"][style*="--depth: 1"]`);
  await until("the folder copy has the folder", () => existsSync(join(folder, "Projects", "MDM2.md")), 20000);
  await shot("files-folders-dark");
} else console.log("  (skipped: the wiki model has no folders yet)");

step("an AI change from the tools arrives live");
await tool("append", { title: "TP53", text: "Mutated in about half of human cancers.", heading: "In my research" });
await page.click('.wiki-side-tab[data-panel="search"]');
await page.fill("#searchInput", "cancers");
await until("the panel hears the change", async () => /TP53/.test(await page.textContent(".wiki-side .wiki-results")));

step("trash: move a page there, restore it");
await page.evaluate(() => window.wikiApp.openPage("Reading note 4"));
await until("note 4", async () => (await activeTab()) === "Reading note 4");
await run("trash-page");
await page.waitForSelector(".wiki-modal");
await page.click(".wiki-modal-foot .danger");
await until("trashed", async () => (await page.evaluate(() => window.wikiApp.wiki.trashed().length)) === 1);
await page.click('.wiki-foot-item[title="Trash"]');
await page.waitForSelector(".wiki-list-row");
await shot("trash-dark");
await page.click(".wiki-list-row button:has-text('Restore')");
await until("restored", async () => (await page.evaluate(() => window.wikiApp.wiki.trashed().length)) === 0);

step("sidebars hide (Ctrl+\\, Ctrl+Shift+\\), resize, focus mode");
await page.locator(".wiki-view").click({ position: { x: 600, y: 700 } });
const leftWidth = await page.evaluate(() => document.querySelector("#leftSide").offsetWidth);
const split = await page.locator(".wiki-split.left").boundingBox();
await page.mouse.move(split.x + 1, split.y + 200);
await page.mouse.down();
await page.mouse.move(split.x + 81, split.y + 200, { steps: 5 });
await page.mouse.up();
assert.ok(Math.abs((await page.evaluate(() => document.querySelector("#leftSide").offsetWidth)) - leftWidth - 80) <= 2,
  "the left sidebar is 80 px wider");
assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem("wiki.layout"))).left.width >= leftWidth + 78);
await page.keyboard.press("Control+\\");
await until("left hidden", async () => !(await page.isVisible("#leftSide")));
await page.keyboard.press("Control+\\");
await until("left shown", async () => page.isVisible("#leftSide"));
await page.keyboard.press("Control+Shift+F");
await until("focus mode", async () => !(await page.isVisible(".wiki-bar")) && !(await page.isVisible("#leftSide")));
await shot("focus-dark");
await page.keyboard.press("Control+Shift+F");
await until("focus mode off", async () => page.isVisible(".wiki-bar"));

step("tabs come back after a reload");
const tabsBefore = await page.locator(".wiki-tab .wiki-tab-title").allTextContents();
await sleep(600);
await page.reload();
await page.waitForSelector(".wiki-tab");
await until("tabs restored",
  async () => (await page.locator(".wiki-tab .wiki-tab-title").allTextContents()).join() === tabsBefore.join());

step("light theme from layr");
await shell.call("settings.set", { key: "theme", value: { mode: "light" } });
await until("light", async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
await page.evaluate(() => window.wikiApp.openPage("TP53"));
await page.click('.wiki-side-tab[data-panel="files"]');
await shot("page-light");
await page.evaluate(() => window.wikiApp.open({ view: "home" }));
await page.waitForSelector(".wiki-home .wiki-actions");
await shot("home-light");
await run("command-palette");
await page.waitForSelector("#palette .wiki-chooser-row");
await shot("palette-light");
await page.keyboard.press("Escape");
await page.evaluate(() => window.wikiApp.open({ view: "settings" }));
await page.waitForSelector(".wiki-settings");
await shot("settings-light");

step("phone: one column, drawers, tab switcher, quick capture");
await page.setViewportSize({ width: 390, height: 800 });
await page.evaluate(() => window.wikiApp.open({ view: "home" }));
await until("phone layout",
  async () => page.evaluate(() => document.querySelector("#wiki").classList.contains("phone")));
assert.ok(!(await page.isVisible("#leftSide")), "the sidebars are closed on the phone");
assert.ok(await page.isVisible("#btnTabs"), "the tab switcher shows");
await shot("phone-home-light");
await page.click("#btnLeft");
await until("left drawer", async () => page.isVisible("#leftSide"));
await shot("phone-drawer-light");
await page.click(".wiki-scrim", { position: { x: 370, y: 400 } });
await until("drawer closed", async () => !(await page.isVisible("#leftSide")));
await page.click("#btnTabs");
await page.waitForSelector(".wiki-tablist li");
await shot("phone-tabs-light");
await page.keyboard.press("Escape");
const pagesBefore = await page.evaluate(() => window.wikiApp.wiki.live().length);
await page.click("#fab");
await until("a quick note",
  async () => (await page.evaluate(() => window.wikiApp.wiki.live().length)) === pagesBefore + 1);
assert.match(await activeTab(), /^Note \d{4}-\d\d-\d\d \d\d\.\d\d/);
await shot("phone-quicknote-light");
await page.evaluate(() => window.wikiApp.openPage("TP53"));
await until("TP53", async () => (await activeTab()) === "TP53");
await shot("phone-page-light");
await shell.call("settings.set", { key: "theme", value: { mode: "dark" } });
await page.evaluate(() => window.wikiApp.open({ view: "settings" }));
await page.waitForSelector(".wiki-settings");
await shot("phone-settings-dark");

step("quick note and today's note by the panel's params (layr commands)");
const { url: url2 } = await shell.call("panels.create", { plugin: "wiki", panel: "main", params: { quickNote: true } });
const p2 = await ctx.newPage();
await p2.setViewportSize({ width: 1000, height: 700 });
await p2.goto(url2);
await p2.waitForSelector(".wiki-tab");
await until("quick note from params",
  async () => /^Note /.test(await p2.textContent(".wiki-tab.active .wiki-tab-title")));
await p2.close();

assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
console.log("PASS: tools, folder copy, panel (tabs, tree, folders, search, tags, bookmarks, switcher, palette, " +
  "hotkeys, " +
  "settings, trash, focus, restore, light, phone)");
await cleanup();
process.exit(0);
