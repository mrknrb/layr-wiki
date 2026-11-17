import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changedFromSync, createBackend } from "../backend/core.js";
import { appendText, authorOf } from "../backend/tools.js";
import { memoryAdapter } from "./memory.js";

const AGENT = { "layr/caller": { kind: "agent", plugin: "claude", label: "t_abc" } };

/** A fake Supabase Storage: objects in a Map, the same answers the real one gives. */
function fakeStorage({ bucket = true } = {}) {
  const objects = new Map();
  const fetch = async (url, { method, body } = {}) => {
    const key = url.split("/lf-wiki/")[1];
    const res = (status, data, text = "") => ({
      ok: status < 300, status, text: async () => text,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    });
    if (!bucket) return res(400, null, '{"statusCode":"404","error":"Bucket not found"}');
    if (method === "POST") {
      objects.set(key, Buffer.from(body));
      return res(200, Buffer.alloc(0));
    }
    return objects.has(key) ? res(200, objects.get(key)) : res(400, null, '{"error":"not_found"}');
  };
  return { objects, fetch };
}

async function setup({ folder = null, storage = fakeStorage() } = {}) {
  const adapter = memoryAdapter();
  const backend = createBackend({
    adapter,
    session: async () => ({ url: "https://x.supabase.co", key: "anon", accessToken: "t", userId: "u1" }),
    settings: async () => ({ mirror: Boolean(folder), folder: folder ?? "" }),
    device: "pc1",
  });
  backend.files.fetch = storage.fetch;
  return { adapter, backend, call: (name, args, meta = AGENT) => backend.call(name, args, meta), storage };
}

test("authors: agents are the AI, panels the user, other plugins by name", () => {
  assert.deepEqual(authorOf(AGENT), { by: "ai", agent: "t_abc" });
  assert.deepEqual(authorOf({ "layr/caller": { kind: "panel", plugin: "wiki" } }), { by: "you", agent: null });
  assert.deepEqual(authorOf({ "layr/caller": { kind: "backend", plugin: "pipeline" } }), { by: "plugin:pipeline", agent: null });
  assert.deepEqual(authorOf(undefined), { by: "you", agent: null });
});

test("create, read, edit, append, set_properties as the AI", async () => {
  const { backend, call } = await setup();
  assert.match(await call("create", { title: "TP53", type: "Gene", properties: { aliases: ["p53"], ncbi_gene: 7157 } }),
    /Created \[\[TP53\]\] \(layr:\/\/wiki\/page\/TP53\)/);
  await assert.rejects(call("create", { title: "p53" }), /exists already as \[\[TP53\]\]/);
  await call("append", { title: "p53", text: "Guardian of the genome; regulated by [[MDM2]].", heading: "Function" });
  await call("edit", { title: "TP53", old_text: "Guardian", new_text: "The guardian" });
  await assert.rejects(call("edit", { title: "TP53", old_text: "nothing like this", new_text: "x" }), /not in/);
  await call("set_properties", { title: "TP53", properties: { organism: "[[Homo sapiens]]" } });
  const text = await call("read", { title: "tp53" });
  assert.match(text, /type: Gene · last change .* by AI \(t_abc\)/);
  assert.ok(text.includes("links to pages that don't exist yet: [[Homo sapiens]], [[MDM2]]"));
  assert.match(text, /## Function\n\nThe guardian of the genome/);
  assert.match(text, /organism: "\[\[Homo sapiens\]\]"/);
  const page = backend.wiki.find("TP53");
  assert.equal(page.by, "ai");
  assert.equal(page.agent, "t_abc");
});

test("search, list, overview, types", async () => {
  const { call } = await setup();
  await call("create", { title: "Western blot", type: "Method", body: "Detects proteins after SDS-PAGE." });
  await call("create", { title: "Home", body: "[[Western blot]] [[ELISA]]" });
  assert.match(await call("search", { query: "sds-page" }), /\[\[Western blot\]\] \(Method\)/);
  assert.match(await call("search", { query: "zebrafish" }), /No pages match/);
  assert.match(await call("list", {}), /2 pages\n- Home\n- Western blot \(Method\)/);
  const overview = await call("overview", {});
  assert.match(overview, /2 pages/);
  assert.match(overview, /Wanted pages \(1\): \[\[ELISA\]\] ×1/);
  assert.match(await call("types", {}), /🧬 Gene \(0 pages\)/);
});

test("rename, trash, history and restore", async () => {
  const { call, backend } = await setup();
  await call("create", { title: "p53", body: "v1" });
  await call("create", { title: "Notes", body: "see [[p53]]" });
  assert.match(await call("rename", { title: "p53", new_title: "TP53" }), /links fixed in 1 other page/);
  assert.match(backend.wiki.find("Notes").markdown, /\[\[TP53\]\]/);
  await call("write", { title: "TP53", markdown: "v2" }, { "layr/caller": { kind: "panel", plugin: "wiki" } });
  await call("write", { title: "TP53", markdown: "v3 by AI" });
  const history = await call("history", { title: "TP53" });
  assert.match(history, /by AI \(t_abc\)/);
  await call("restore", { title: "TP53" });
  assert.equal(backend.wiki.find("TP53").markdown, "v2");
  await call("trash", { title: "TP53" });
  await assert.rejects(call("read", { title: "TP53" }).then((t) => {
    if (/in the trash/.test(t)) throw new Error("trashed");
  }), /trashed/);
  await call("restore", { title: "TP53" });
  assert.ok(backend.wiki.find("TP53"));
});

test("append puts text at the end of a section and makes missing headings", () => {
  const md = "---\ntype: Paper\n---\n\n## Summary\n\nOne.\n\n## Key claims\n\n- a\n";
  assert.equal(appendText(md, "Two.", "summary"),
    "---\ntype: Paper\n---\n\n## Summary\n\nOne.\n\nTwo.\n\n## Key claims\n\n- a\n");
  assert.equal(appendText(md, "Hm", "Open questions").split("\n").slice(-4).join("\n"), "## Open questions\n\nHm\n");
  assert.equal(appendText("", "First"), "First\n");
});

test("attachments: upload once per content, names kept unique, attach embeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-att-"));
  try {
    const { call, backend, storage } = await setup();
    await call("create", { title: "Exp 1", body: "" });
    const file = path.join(dir, "gel.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    assert.match(await call("attach", { path: file, title: "Exp 1", heading: "Results" }), /embedded it in \[\[Exp 1\]\]/);
    assert.match(backend.wiki.find("Exp 1").markdown, /## Results\n\n!\[\[gel.png\]\]/);
    await writeFile(file, Buffer.from([9]));
    assert.match(await call("attach", { path: file }), /gel \(2\)\.png/);
    assert.equal(storage.objects.size, 2);
    const { bytes } = await backend.files.download("GEL.png");
    assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachments without the bucket say what to do", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-att-"));
  try {
    const { call } = await setup({ storage: fakeStorage({ bucket: false }) });
    const file = path.join(dir, "a.pdf");
    await writeFile(file, "x");
    await assert.rejects(call("attach", { path: file }), /lf_0004_wiki_files\.sql/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("folder copy: files per page, renames, trash, changed files kept", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-mirror-"));
  try {
    const { call, backend } = await setup({ folder: dir });
    await call("create", { title: "TP53", body: "Gene" });
    await call("create", { title: "Home", body: "[[TP53]]" });
    await call("attach", { path: await (async () => {
      const f = path.join(dir, "..", `pic-${Date.now()}.png`);
      await writeFile(f, Buffer.from([7]));
      return f;
    })(), title: "Home" });
    await backend.mirror.run();
    let names = (await readdir(dir)).sort();
    assert.deepEqual(names.filter((n) => !n.startsWith(".")), ["Home.md", "TP53.md", "attachments"]);
    assert.equal(await readFile(path.join(dir, "TP53.md"), "utf8"), "Gene\n");
    assert.equal((await readdir(path.join(dir, "attachments"))).length, 1);

    // Someone edits a file in the folder, then the page is renamed: the edit is kept aside.
    await writeFile(path.join(dir, "TP53.md"), "edited outside\n");
    await call("rename", { title: "TP53", new_title: "Tumor protein p53" });
    await backend.mirror.run();
    names = await readdir(dir);
    assert.ok(names.includes("Tumor protein p53.md") && !names.includes("TP53.md"));
    const kept = await readdir(path.join(dir, ".layr-wiki", "overwritten"));
    assert.equal(kept.length, 1);
    assert.match(await readFile(path.join(dir, "Home.md"), "utf8"), /\[\[Tumor protein p53\]\]/);

    await call("trash", { title: "Home" });
    await backend.mirror.run();
    assert.ok(!(await readdir(dir)).includes("Home.md"));
    assert.equal(backend.mirror.status().error, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("folder copy keeps a file of the same name that was there before", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-mirror-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "Ideas.md"), "my old file\n");
    const { call, backend } = await setup({ folder: dir });
    await call("create", { title: "Ideas", body: "new" });
    await backend.mirror.run();
    assert.equal(await readFile(path.join(dir, "Ideas.md"), "utf8"), "new\n");
    const kept = await readdir(path.join(dir, ".layr-wiki", "overwritten"));
    assert.equal(await readFile(path.join(dir, ".layr-wiki", "overwritten", kept[0]), "utf8"), "my old file\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import a folder (an Obsidian vault) with its pictures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-import-"));
  try {
    await mkdir(path.join(dir, "Papers"), { recursive: true });
    await mkdir(path.join(dir, ".obsidian"), { recursive: true });
    await writeFile(path.join(dir, "Home.md"), "Start [[Smith 2020]]\r\n![[fig1.png]]");
    await writeFile(path.join(dir, "Papers", "Smith 2020.md"), "---\ntype: Paper\n---\n\nA paper");
    await writeFile(path.join(dir, "Papers", "fig1.png"), Buffer.from([1]));
    await writeFile(path.join(dir, ".obsidian", "app.md"), "ignored");
    const { call, backend } = await setup();
    await call("create", { title: "Home", body: "mine" });
    const text = await call("import_folder", { path: dir });
    assert.match(text, /2 Markdown file\(s\): 1 new, 0 replaced, 1 left alone/);
    assert.equal(backend.wiki.find("Smith 2020").type, "Paper");
    assert.equal(backend.wiki.find("Home").markdown, "mine");
    await call("import_folder", { path: dir, overwrite: true });
    assert.equal(backend.wiki.find("Home").markdown, "Start [[Smith 2020]]\n![[fig1.png]]");
    assert.ok(await backend.files.get("fig1.png"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync events name the changed pages", () => {
  assert.deepEqual(changedFromSync({ collections: { pages: ["a"] }, keys: ["rev/a/x", "type/gene"] }), { ids: ["a"], types: true });
  assert.deepEqual(changedFromSync(null), { ids: [], types: false });
});
