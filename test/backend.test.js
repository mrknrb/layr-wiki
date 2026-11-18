import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changedFromSync, createBackend } from "../backend/core.js";
import { appendText, authorOf, READS } from "../backend/tools.js";
import { writeSettings } from "../shared/settings.js";
import { memoryAdapter } from "./memory.js";

const AGENT = { "layr/caller": { kind: "agent", plugin: "claude", label: "t_abc" } };
const PANEL = { "layr/caller": { kind: "panel", plugin: "wiki" } };

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

async function setup({ folder = null, storage = fakeStorage(), settings = null } = {}) {
  const adapter = memoryAdapter();
  if (settings) await writeSettings(adapter, settings);
  const backend = createBackend({
    adapter,
    session: async () => ({ url: "https://x.supabase.co", key: "anon", accessToken: "t", userId: "u1" }),
    settings: async () => ({ mirror: Boolean(folder), folder: folder ?? "" }),
    device: "pc1",
  });
  backend.files.fetch = storage.fetch;
  return { adapter, backend, call: (name, args, meta = AGENT) => backend.call(name, args, meta), storage };
}

const exists = (file) => stat(file).then(() => true, () => false);

test("authors: agents are the AI, panels the user, other plugins by name", () => {
  assert.deepEqual(authorOf(AGENT), { by: "ai", agent: "t_abc" });
  assert.deepEqual(authorOf(PANEL), { by: "you", agent: null });
  assert.deepEqual(authorOf({ "layr/caller": { kind: "backend", plugin: "pipeline" } }), { by: "plugin:pipeline", agent: null });
  assert.deepEqual(authorOf(undefined), { by: "you", agent: null });
});

test("create, read, edit, append, set_properties as the AI", async () => {
  const { backend, call } = await setup();
  await call("define_type", { name: "Book", fields: [{ key: "author", kind: "link" }, { key: "year", kind: "number" }],
    template: "## Summary\n\n## Notes\n" }, PANEL);
  assert.match(await call("create", { title: "Dune", type: "Book", folder: "Reading", properties: { aliases: ["Dune (novel)"], year: 1965 } }),
    /Created \[\[Dune\]\] in Reading \(layr:\/\/wiki\/page\/Dune\)/);
  await assert.rejects(call("create", { title: "dune (novel)" }), /exists already as \[\[Dune\]\] in Reading/);
  await call("append", { title: "dune (novel)", text: "Desert planet; written by [[Frank Herbert]].", heading: "Summary" });
  await call("edit", { title: "Dune", old_text: "Desert planet", new_text: "A desert planet" });
  await assert.rejects(call("edit", { title: "Dune", old_text: "nothing like this", new_text: "x" }), /not in/);
  await call("set_properties", { title: "Dune", properties: { author: "[[Frank Herbert]]" } });
  const text = await call("read", { title: "dune" });
  assert.match(text, /type: Book · folder: Reading · last change .* by AI \(t_abc\)/);
  assert.ok(text.includes("links to pages that don't exist yet: [[Frank Herbert]]"));
  assert.match(text, /## Summary\n\nA desert planet/);
  assert.match(text, /author: "\[\[Frank Herbert\]\]"/);
  const page = backend.wiki.find("Dune");
  assert.equal(page.by, "ai");
  assert.equal(page.agent, "t_abc");
});

test("search, list, overview, types, folders", async () => {
  const { call } = await setup();
  await call("create", { title: "Sourdough", type: "Recipe", folder: "Kitchen/Bread", body: "Flour, water and salt." });
  await call("create", { title: "Home", body: "[[Sourdough]] [[Pizza]]" });
  assert.match(await call("search", { query: "flour" }), /\[\[Sourdough\]\] \(Recipe\) in Kitchen\/Bread/);
  assert.match(await call("search", { query: "", folder: "kitchen" }), /Sourdough/);
  assert.match(await call("search", { query: "flour", folder: "Garden" }), /No pages match "flour" in Garden/);
  assert.match(await call("list", {}), /2 pages\n- Home\n- Sourdough \(Recipe\) in Kitchen\/Bread/);
  assert.match(await call("list", { folder: "Kitchen", subfolders: false }), /^0 pages/);
  const overview = await call("overview", {});
  assert.match(overview, /2 pages \(0 in the trash\), 2 folders/);
  assert.match(overview, /By folder: (Kitchen 1, \(top\) 1|\(top\) 1, Kitchen 1)/);
  assert.match(overview, /Wanted pages \(1\): \[\[Pizza\]\] ×1/);
  assert.match(overview, /Review mode: off/);
  assert.match(await call("types", {}), /no page types yet\.\nUsed by pages but not defined: Recipe \(1\)/);
  assert.equal(await call("folders", {}), "(top) 1 page(s)\n- Kitchen: 0 page(s), 1 with subfolders\n  - Kitchen/Bread: 1 page(s)");
});

test("folders and types through the tools", async () => {
  const { call, backend } = await setup();
  await call("create_folder", { path: "Projects/Thesis" });
  await call("create", { title: "Outline", folder: "Projects/Thesis" });
  assert.match(await call("move", { title: "Outline", folder: "Archive" }), /Moved \[\[Outline\]\] to Archive/);
  assert.match(await call("rename_folder", { from: "Archive", to: "Old/Archive" }), /now Old\/Archive; 1 page/);
  assert.equal(backend.wiki.find("Outline").folder, "Old/Archive");
  assert.deepEqual(backend.wiki.folders(), ["Old", "Old/Archive", "Projects", "Projects/Thesis"]);

  await call("define_type", { name: "Person", icon: "user", fields: [{ key: "email", kind: "url" },
    { key: "team", kind: "select", options: ["A", "B"] }] });
  await assert.rejects(call("define_type", { name: "Bad", fields: [{ key: "x", kind: "colour" }] }), /kind is one of/);
  await call("create", { title: "Ann Lee", type: "Person" });
  assert.match(await call("types", {}), /- user Person \(1 pages\): email:url, team:select\(A\|B\)/);
  assert.match(await call("delete_type", { name: "person" }), /Type Person deleted; 1 page\(s\) still say type: Person/);
});

test("templates and daily notes through the tools", async () => {
  const { call, backend } = await setup({ settings: { dailyFolder: "Journal", dailyTemplate: "Day" } });
  assert.match(await call("templates", {}), /No templates yet \(pages in the folder "Templates"/);
  await call("create", { title: "Day", folder: "Templates", body: "# {{date:dddd}}\n\n## Tasks\n\n- [ ] \n" });
  await call("create", { title: "Meeting", folder: "Templates", body: "# {{title}}\n\n## Actions\n" });
  assert.match(await call("templates", {}), /- \[\[Day\]\]: # \{\{date:dddd\}\}\n- \[\[Meeting\]\]: # \{\{title\}\}/);
  await call("create", { title: "Kickoff", template: "Meeting", folder: "Work" });
  assert.equal(backend.wiki.find("Kickoff").markdown, "# Kickoff\n\n## Actions\n");
  const day = await call("daily_note", { date: "2026-11-18" });
  assert.match(day, /^# 2026-11-18\ntype: none · folder: Journal/);
  assert.match(day, /# Wednesday\n\n## Tasks/);
  assert.match(await call("daily_note", { date: "2026-11-19", create: false }), /no daily note for 2026-11-19/);
});

test("review mode: the AI's changes wait for the user's review", async () => {
  const { call, backend, adapter } = await setup({ settings: { aiReview: true } });
  await call("create", { title: "Garden", body: "Beds: two." }, PANEL);
  assert.match(await call("create", { title: "Compost", folder: "Garden", body: "Brown and green." }),
    /^Proposed: create \[\[Compost\]\] in Garden — waiting for the user's review in the Wiki's Review page/);
  // The agent keeps working on its pending new page.
  await call("append", { title: "Compost", text: "Turn it monthly." });
  assert.match(await call("read", { title: "Compost" }), /Not created yet[^]*Brown and green\.\n\nTurn it monthly\./);

  assert.match(await call("edit", { title: "Garden", old_text: "two", new_text: "three" }), /^Proposed: change \[\[Garden\]\]/);
  await call("append", { title: "Garden", text: "Water daily.", heading: "Care" });
  assert.equal(backend.wiki.find("Garden").markdown, "Beds: two.");
  const read = await call("read", { title: "Garden" });
  assert.match(read, /waiting for the user's review: change \[\[Garden\]\] by AI \(t_abc\)/);
  assert.match(read, /Your pending version[^]*Beds: three\.\n\n## Care\n\nWater daily\./);
  assert.match(await call("rename", { title: "Garden", new_title: "Yard" }), /^Proposed: rename \[\[Garden\]\] to \[\[Yard\]\]/);
  assert.match(await call("trash", { title: "Garden" }), /^Proposed: move \[\[Garden\]\] to the trash/);
  const list = await call("proposals", {});
  assert.match(list, /Review mode is on\. 4 change\(s\) waiting/);
  assert.match(await call("overview", {}), /Review mode: on .*; 4 change\(s\) waiting/);

  // The user (the panel) accepts and rejects.
  const [create, save, rename, trash] = backend.wiki.proposals();
  await backend.wiki.accept(create.id);
  await backend.wiki.accept(save.id);
  await backend.wiki.accept(rename.id);
  await backend.wiki.reject(trash.id);
  assert.equal(backend.wiki.find("Compost").markdown, "Brown and green.\n\nTurn it monthly.\n");
  assert.equal(backend.wiki.find("Yard").markdown, "Beds: three.\n\n## Care\n\nWater daily.\n");
  assert.match(await call("proposals", {}), /Nothing is waiting/);

  // Review turned off on another device: the backend reads the settings again.
  await writeSettings(adapter, { aiReview: false });
  await backend.onChanged(changedFromSync({ keys: ["settings"] }));
  assert.match(await call("append", { title: "Yard", text: "Done." }), /^Added to \[\[Yard\]\]/);
});

test("settings: history settings reach the model, reloaded after a change", async () => {
  const { backend, adapter } = await setup({ settings: { historyMinutes: 3, historyRecent: 10, historyMax: 30 } });
  const wiki = await backend.getWiki();
  assert.deepEqual(wiki.history, { ms: 180_000, recent: 10, max: 30 });
  await writeSettings(adapter, { historyMinutes: 1 });
  await backend.onChanged({ settings: true });
  assert.equal(wiki.history.ms, 60_000);
  await writeSettings(adapter, { historyMinutes: 5 });
  await backend.reloadSettings();
  assert.equal(wiki.history.ms, 300_000);
});

test("rename, trash, history and restore", async () => {
  const { call, backend } = await setup();
  await call("create", { title: "q3 plan", body: "v1" });
  await call("create", { title: "Notes", body: "see [[q3 plan]]" });
  assert.match(await call("rename", { title: "q3 plan", new_title: "Q3 Plan" }), /links fixed in 1 other page/);
  assert.match(backend.wiki.find("Notes").markdown, /\[\[Q3 Plan\]\]/);
  await call("write", { title: "Q3 Plan", markdown: "v2" }, PANEL);
  await call("write", { title: "Q3 Plan", markdown: "v3 by AI" });
  const history = await call("history", { title: "Q3 Plan" });
  assert.match(history, /by AI \(t_abc\)/);
  await call("restore", { title: "Q3 Plan" });
  assert.equal(backend.wiki.find("Q3 Plan").markdown, "v2");
  await call("trash", { title: "Q3 Plan" });
  assert.match(await call("read", { title: "Q3 Plan" }), /in the trash/);
  await call("restore", { title: "Q3 Plan" });
  assert.ok(backend.wiki.find("Q3 Plan"));
});

test("append puts text at the end of a section and makes missing headings", () => {
  const md = "---\ntype: Book\n---\n\n## Summary\n\nOne.\n\n## Quotes\n\n- a\n";
  assert.equal(appendText(md, "Two.", "summary"),
    "---\ntype: Book\n---\n\n## Summary\n\nOne.\n\nTwo.\n\n## Quotes\n\n- a\n");
  assert.equal(appendText(md, "Hm", "Open questions").split("\n").slice(-4).join("\n"), "## Open questions\n\nHm\n");
  assert.equal(appendText("", "First"), "First\n");
});

test("attachments: upload once per content, names kept unique, attach embeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-att-"));
  try {
    const { call, backend, storage } = await setup();
    await call("create", { title: "Trip", body: "" });
    const file = path.join(dir, "photo.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    assert.match(await call("attach", { path: file, title: "Trip", heading: "Photos" }), /embedded it in \[\[Trip\]\]/);
    assert.match(backend.wiki.find("Trip").markdown, /## Photos\n\n!\[\[photo.png\]\]/);
    await writeFile(file, Buffer.from([9]));
    assert.match(await call("attach", { path: file }), /photo \(2\)\.png/);
    assert.equal(storage.objects.size, 2);
    const { bytes } = await backend.files.download("PHOTO.png");
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
    await call("create", { title: "Garden", body: "Beds" });
    await call("create", { title: "Home", body: "[[Garden]]" });
    await call("attach", { path: await (async () => {
      const f = path.join(dir, "..", `pic-${Date.now()}.png`);
      await writeFile(f, Buffer.from([7]));
      return f;
    })(), title: "Home" });
    await backend.mirror.run();
    let names = (await readdir(dir)).sort();
    assert.deepEqual(names.filter((n) => !n.startsWith(".")), ["Garden.md", "Home.md", "attachments"]);
    assert.equal(await readFile(path.join(dir, "Garden.md"), "utf8"), "Beds\n");
    assert.equal((await readdir(path.join(dir, "attachments"))).length, 1);

    // Someone edits a file in the folder, then the page is renamed: the edit is kept aside.
    await writeFile(path.join(dir, "Garden.md"), "edited outside\n");
    await call("rename", { title: "Garden", new_title: "Vegetable garden" });
    await backend.mirror.run();
    names = await readdir(dir);
    assert.ok(names.includes("Vegetable garden.md") && !names.includes("Garden.md"));
    const kept = await readdir(path.join(dir, ".layr-wiki", "overwritten"));
    assert.equal(kept.length, 1);
    assert.match(await readFile(path.join(dir, "Home.md"), "utf8"), /\[\[Vegetable garden\]\]/);

    await call("trash", { title: "Home" });
    await backend.mirror.run();
    assert.ok(!(await readdir(dir)).includes("Home.md"));
    assert.equal(backend.mirror.status().error, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("folder copy: folders as folders, moves, empty folders made and cleaned", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-mirror-"));
  try {
    const { call, backend } = await setup({ folder: dir });
    await call("create", { title: "Plan", folder: "Projects/Thesis", body: "v1" });
    await call("create_folder", { path: "Empty/Inner" });
    await backend.mirror.run();
    assert.equal(await readFile(path.join(dir, "Projects", "Thesis", "Plan.md"), "utf8"), "v1\n");
    assert.ok(await exists(path.join(dir, "Empty", "Inner")));
    assert.equal(backend.mirror.status().folders, 4);

    // A move is like a rename: the old file goes (kept aside when it was changed there), the folder left behind is
    // the wiki's still, so it stays.
    await writeFile(path.join(dir, "Projects", "Thesis", "Plan.md"), "changed in the folder\n");
    await call("move", { title: "Plan", folder: "Archive" });
    await backend.mirror.run();
    assert.ok(!(await exists(path.join(dir, "Projects", "Thesis", "Plan.md"))));
    assert.equal(await readFile(path.join(dir, "Archive", "Plan.md"), "utf8"), "v1\n");
    assert.equal((await readdir(path.join(dir, ".layr-wiki", "overwritten"))).length, 1);
    assert.ok(!(await exists(path.join(dir, "Projects"))), "the folder only Plan made is gone with it");

    // A folder the wiki removed goes when empty; one holding someone else's file stays.
    await writeFile(path.join(dir, "Empty", "mine.txt"), "x");
    await backend.wiki.deleteFolder("Empty");
    await backend.mirror.run();
    assert.ok(!(await exists(path.join(dir, "Empty", "Inner"))));
    assert.ok(await exists(path.join(dir, "Empty", "mine.txt")));
    await backend.wiki.renameFolder("Archive", "Old");
    await backend.mirror.run();
    assert.ok(await exists(path.join(dir, "Old", "Plan.md")));
    assert.ok(!(await exists(path.join(dir, "Archive"))));
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

test("import a folder (an Obsidian vault) with its folders and pictures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-import-"));
  try {
    await mkdir(path.join(dir, "Books", "Fiction"), { recursive: true });
    await mkdir(path.join(dir, ".obsidian"), { recursive: true });
    await writeFile(path.join(dir, "Home.md"), "Start [[Dune]]\r\n![[cover.png]]");
    await writeFile(path.join(dir, "Books", "Fiction", "Dune.md"), "---\ntype: Book\n---\n\nA novel");
    await writeFile(path.join(dir, "Books", "cover.png"), Buffer.from([1]));
    await writeFile(path.join(dir, ".obsidian", "app.md"), "ignored");
    const { call, backend } = await setup();
    await call("create", { title: "Home", body: "mine" });
    const text = await call("import_folder", { path: dir });
    assert.match(text, /2 Markdown file\(s\): 1 new, 0 replaced, 1 left alone/);
    assert.equal(backend.wiki.find("Dune").type, "Book");
    assert.equal(backend.wiki.find("Dune").folder, "Books/Fiction");
    assert.equal(backend.wiki.find("Home").markdown, "mine");
    await call("import_folder", { path: dir, overwrite: true });
    assert.equal(backend.wiki.find("Home").markdown, "Start [[Dune]]\n![[cover.png]]");
    assert.ok(await backend.files.get("cover.png"));
    assert.equal(backend.wiki.find("app"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import into a folder", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-import-"));
  try {
    await mkdir(path.join(dir, "Sub"), { recursive: true });
    await writeFile(path.join(dir, "Sub", "Note.md"), "x");
    const { call, backend } = await setup();
    await call("import_folder", { path: dir, into: "Imported" });
    assert.equal(backend.wiki.find("Note").folder, "Imported/Sub");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync events name what changed", () => {
  assert.deepEqual(changedFromSync({ collections: { pages: ["a"] }, keys: ["rev/a/x", "type/book"] }),
    { ids: ["a"], types: true, folders: false, bookmarks: false, proposals: false, settings: false });
  assert.deepEqual(changedFromSync({ keys: ["folder/x", "bookmarks", "proposal/1", "settings"] }),
    { ids: [], types: false, folders: true, bookmarks: true, proposals: true, settings: true });
  assert.deepEqual(changedFromSync(null),
    { ids: [], types: false, folders: false, bookmarks: false, proposals: false, settings: false });
});

test("READS lists only tools that don't change pages", () => {
  for (const name of ["folders", "templates", "proposals", "read", "search"]) assert.ok(READS.has(name), name);
  for (const name of ["move", "create_folder", "rename_folder", "define_type", "delete_type", "daily_note"]) {
    assert.ok(!READS.has(name), name);
  }
});
