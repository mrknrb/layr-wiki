// The Wiki panel and backend through a real core, in headless Chromium. Starts `layr serve` (a copy of core's debug
// build) on a free port with a temporary home and this plugin linked, points the folder copy at a temporary folder,
// writes pages with the backend's tools (over /mcp), clicks through the panel (links, editing with [[ completion,
// history, the phone layout), checks the folder copy, and takes screenshots into screenshots/. Turns on developer mode
// in its temporary home (the plugin is a linked folder with a backend). Needs no sign-in:
// pages are local data until the core is signed in (attachments, which need it, are covered by backend.test.js).
//   cargo build -p layr_cli   (in core/), then:  node test/panel.e2e.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

// ---------- the core ----------

const port = await freePort();
const token = "e2e-" + Math.random().toString(36).slice(2);
const home = mkdtempSync(join(tmpdir(), "layr-wiki-e2e-"));
const folder = join(home, "vault");
const exe = join(home, process.platform === "win32" ? "layr.exe" : "layr");
copyFileSync(join(CORE, "target", "debug", process.platform === "win32" ? "layr.exe" : "layr"), exe);
const core = spawn(exe, ["serve", "--port", String(port), "--token", token, "--home", join(home, "home"), "--link", PLUGIN], {
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
  console.log(coreLog.slice(-4000));
  await cleanup();
  process.exit(1);
});
process.on("unhandledRejection", (error) => process.emit("uncaughtException", error));

await until("layr serve", async () => fetch(`http://127.0.0.1:${port}/_layr/layr.js`).then((r) => r.ok, () => false), 60000);

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
await tool("create", { title: "TP53", type: "Gene", properties: { aliases: ["p53"], symbol: "TP53", ncbi_gene: 7157,
  organism: "[[Homo sapiens]]" } });
await tool("append", { title: "TP53", heading: "Function",
  text: "A transcription factor that stops the cell cycle after DNA damage. Its level is kept low by [[MDM2]].\n\n" +
    "> [!question] Does it act the same way in [[Mouse|mice]]?" });
await tool("create", { title: "MDM2", type: "Gene", body: "## Function\n\nAn E3 ubiquitin ligase that marks p53 for " +
  "degradation. See [[TP53#Function]].\n" });
await tool("create", { title: "Western blot", type: "Method", body: "## Protocol\n\n1. SDS-PAGE\n2. Transfer\n3. " +
  "Antibody against TP53\n\n| Step | Time |\n| --- | --- |\n| Blocking | 1 h |\n| Primary | overnight |\n" });
await tool("create", { title: "Home", type: "Topic", body: "## Overview\n\nMy PhD: [[TP53]], [[MDM2]], " +
  "[[Western blot]]. #phd\n" });
assert.match(await tool("read", { title: "p53" }), /linked from: \[\[Home\]\], \[\[MDM2\]\]/);
assert.match(await tool("search", { query: "ubiquitin" }), /\[\[MDM2\]\]/);

// ---------- the folder copy ----------

await until("the folder copy", () => existsSync(join(folder, "TP53.md")) && existsSync(join(folder, "Home.md")), 20000);
assert.match(readFileSync(join(folder, "TP53.md"), "utf8"), /^---\ntype: Gene\n/);

// ---------- the panel ----------

const { url } = await shell.call("panels.create", { plugin: "wiki", panel: "main", params: { page: "TP53" } });
browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForSelector(".page-title");
assert.equal(await page.textContent(".page-title"), "TP53");
assert.match(await page.textContent(".infobox"), /NCBI Gene\s*7157/);
assert.equal(await page.locator(".md a.wl.missing", { hasText: "mice" }).count(), 1);
assert.match(await page.textContent(".refs"), /Linked from \(2\)/);
assert.equal(await page.locator(".callout[data-callout=question]").count(), 1);
await page.screenshot({ path: join(SHOTS, "page-dark.png") });

// A link goes to the page; Back comes back.
await page.click(".md a.wl:has-text('MDM2')");
await until("MDM2", async () => (await page.textContent(".page-title")) === "MDM2");
await page.click("#back");
await until("back to TP53", async () => (await page.textContent(".page-title")) === "TP53");

// Edit: the [[ completion, then the page is saved and the link counts.
await page.click("#editBtn");
await page.waitForSelector("textarea.text");
await page.click("textarea.text");
await page.keyboard.press("Control+End");
await page.keyboard.type("\n\nMeasured by [[Wes");
await page.waitForSelector("#complete:not([hidden]) li");
assert.match(await page.textContent("#complete"), /Western blot/);
await page.screenshot({ path: join(SHOTS, "edit-complete-dark.png") });
await page.keyboard.press("Enter");
await page.keyboard.type(".");
await until("saved", async () => (await page.textContent("#saveState")) === "Saved", 5000);
await page.click("#editBtn");
await page.waitForSelector(".md");
assert.equal(await page.locator(".md a.wl", { hasText: "Western blot" }).count(), 1);
assert.match(await tool("read", { title: "Western blot" }), /linked from: .*\[\[TP53\]\]/);

// The folder copy follows the panel's change.
await until("the folder copy of the edit", () => /\[\[Western blot\]\]/.test(readFileSync(join(folder, "TP53.md"), "utf8")), 20000);

// An AI-style change from the tools shows up in the open panel, with its history.
await tool("append", { title: "TP53", text: "Mutated in about half of human cancers.", heading: "In my research" });
await until("the panel to hear the change", async () => /half of human cancers/.test(await page.textContent(".md")));
await page.click("#historyBtn");
await page.waitForSelector(".rev-list li");
assert.ok((await page.locator(".rev-list li").count()) >= 2);
await page.screenshot({ path: join(SHOTS, "history-dark.png") });
await page.keyboard.press("Escape");

// Overview: counts and wanted pages.
await page.click("#homeBtn");
await page.waitForSelector(".home");
assert.match(await page.textContent(".home"), /Wanted pages/);
assert.match(await page.textContent(".home"), /Homo sapiens/);
await page.screenshot({ path: join(SHOTS, "overview-dark.png") });

// A new page from a red link.
await page.click(".chip.missing:has-text('Mouse')");
await page.waitForSelector(".missing-title");
await page.click("button:has-text('Create it')");
await page.waitForSelector(".modal select");
await page.selectOption(".modal select", "Organism");
await page.click(".modal-foot .primary");
await page.waitForSelector("textarea.text");
assert.match(await page.inputValue("textarea.text"), /type: Organism/);
await page.click("#editBtn");

// Light theme, then the phone layout.
await shell.call("settings.set", { key: "theme", value: { mode: "light" } });
await page.click("#homeBtn");
await page.click(".chip.big");
await page.waitForSelector(".page-title");
await sleep(400);
await page.screenshot({ path: join(SHOTS, "page-light.png") });
await page.setViewportSize({ width: 390, height: 800 });
await page.click("#listBtn");
assert.ok(await page.isVisible("#list"), "the Pages button shows the list on the phone");
await page.screenshot({ path: join(SHOTS, "phone-list-light.png") });
await page.click(".page-list li:has-text('TP53')");
await page.waitForSelector(".page-title");
await page.click("#back");
assert.ok(await page.isVisible("#list"), "a page picked in the list goes back to it");
await page.click(".page-list li:has-text('TP53')");
await page.waitForSelector(".page-title");
await page.screenshot({ path: join(SHOTS, "phone-page-light.png") });

assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], `page errors: ${errors.join("\n")}`);
const want = ["Home.md", "MDM2.md", "Mouse.md", "TP53.md", "Western blot.md"].join();
await until("the page made in the panel in the folder copy", () =>
  readdirSync(folder).filter((n) => n.endsWith(".md")).sort().join() === want, 20000);
console.log("PASS: tools, folder copy, panel (links, edit, completion, live AI change, history, overview, phone)");
await cleanup();
process.exit(0);
