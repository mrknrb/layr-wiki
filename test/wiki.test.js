import assert from "node:assert/strict";
import { test } from "node:test";
import { writeSettings } from "../shared/settings.js";
import { COALESCE_MS, pruneRevisions, undoTarget, Wiki } from "../shared/wiki.js";
import { memoryAdapter } from "./memory.js";

function clock(start = new Date(2026, 10, 17, 9, 30).getTime()) {
  let t = start;
  const now = () => t;
  now.add = (ms) => (t += ms);
  return now;
}

async function setup(options = {}) {
  const a = memoryAdapter();
  const now = clock();
  const wiki = new Wiki(a, { who: "you", device: "d1", now, ...options });
  return { a, now, wiki };
}

const BOOK = {
  name: "Book",
  icon: "book",
  color: "#0b6e99",
  fields: [
    { key: "author", label: "Author", kind: "link", target: "Person" },
    { key: "year", kind: "number" },
    { key: "status", kind: "select", options: ["to read", "reading", "read"] },
    { key: "topics", kind: "multiselect" },
  ],
  template: "## Summary\n\n## Notes\n\nStarted {{date}}\n",
};

const AI = { by: "ai", agent: "t_1" };

test("create from a type's template, find by title and alias", async () => {
  const { wiki } = await setup();
  await wiki.defineType(BOOK);
  const book = await wiki.create({ title: "Thinking, Fast and Slow", type: "Book" });
  assert.equal(book.type, "Book");
  assert.match(book.markdown, /## Summary/);
  assert.match(book.markdown, /Started 2026-11-17/);
  assert.deepEqual(book.props.topics, []);
  assert.ok("author" in book.props);
  await wiki.setProps(book.id, { aliases: ["TFS"] });
  assert.equal(wiki.find("thinking, fast and slow").id, book.id);
  assert.equal(wiki.resolve("tfs").id, book.id);
  await assert.rejects(wiki.create({ title: "THINKING, FAST AND SLOW" }), /already/);
  await assert.rejects(wiki.create({ title: "a|b" }), /can't hold/);
  // A type nobody defined is just written as the page's type.
  const p = await wiki.create({ title: "Lunch", type: "Meal" });
  assert.equal(p.markdown, "---\ntype: Meal\n---\n\n");
});

test("backlinks, wanted pages, orphans, unlinked mentions", async () => {
  const { wiki } = await setup();
  const a = await wiki.create({ title: "Garden", markdown: "Plant [[Tomatoes]]. See [[Compost]]." });
  const b = await wiki.create({ title: "Tomatoes", markdown: "Grow best in the Garden." });
  const c = await wiki.create({ title: "Home", markdown: "Start: [[Garden]]" });
  assert.deepEqual(wiki.backlinks(b.id).map((p) => p.title), ["Garden"]);
  assert.deepEqual(wiki.backlinks(a.id).map((p) => p.title), ["Home"]);
  assert.deepEqual(wiki.wanted().map((w) => w.title), ["Compost"]);
  assert.deepEqual(wiki.orphans().map((p) => p.title), []);
  assert.deepEqual(wiki.unlinkedMentions(a.id).map((p) => p.title), ["Tomatoes"]);
  assert.equal(c.links[0], "Garden");
});

test("properties with links count as links; [[Folder/Title]] means the page", async () => {
  const { wiki } = await setup();
  const ann = await wiki.create({ title: "Ann Lee", folder: "People" });
  await wiki.create({ title: "Weekly sync", markdown: '---\ntype: Meeting\nwith: "[[Ann Lee]]"\n---\n\nText' });
  await wiki.create({ title: "Notes", markdown: "Talk to [[People/Ann Lee]]" });
  assert.deepEqual(wiki.backlinks(ann.id).map((p) => p.title), ["Notes", "Weekly sync"]);
  assert.equal(wiki.resolve("People/Ann Lee").id, ann.id);
});

test("rename fixes links everywhere", async () => {
  const { wiki } = await setup();
  const a = await wiki.create({ title: "q3 plan" });
  const b = await wiki.create({ title: "Notes", markdown: "[[q3 plan]] and [[Q3 Plan|it]] and [[q3 plan#Goals]]" });
  const { updated } = await wiki.rename(a.id, "Q3 Plan", AI);
  assert.equal(updated, 1);
  assert.equal(wiki.pages.get(b.id).markdown, "[[Q3 Plan]] and [[Q3 Plan|it]] and [[Q3 Plan#Goals]]");
  assert.equal(wiki.pages.get(b.id).by, "ai");
  assert.equal(wiki.find("Q3 Plan").id, a.id);
});

test("history: bursts coalesce, authors don't, undo goes back past the AI", async () => {
  const { wiki, now } = await setup();
  const p = await wiki.create({ title: "Page", markdown: "v1" });
  now.add(1000);
  await wiki.save(p.id, "v2");
  now.add(1000);
  await wiki.save(p.id, "v3");
  let revs = await wiki.revisions(p.id);
  assert.deepEqual(revs.map((r) => r.markdown), ["v3", "v1"]);
  now.add(1000);
  await wiki.save(p.id, "ai 1", AI);
  now.add(1000);
  await wiki.save(p.id, "ai 2", AI);
  revs = await wiki.revisions(p.id);
  assert.deepEqual(revs.map((r) => `${r.by}:${r.markdown}`), ["ai:ai 2", "you:v3", "you:v1"]);
  assert.equal(undoTarget(revs).markdown, "v3");
  await wiki.restore(p.id);
  assert.equal(wiki.pages.get(p.id).markdown, "v3");
  now.add(COALESCE_MS + 1);
  await wiki.save(p.id, "later");
  assert.equal((await wiki.revisions(p.id)).length, 5);
});

test("history settings: minutes per version, and how many are kept", async () => {
  const { wiki, now, a } = await setup({ history: { minutes: 1, recent: 3, max: 5 } });
  const p = await wiki.create({ title: "Diary", markdown: "0" });
  now.add(30_000);
  await wiki.save(p.id, "1");
  assert.equal((await wiki.revisions(p.id)).length, 2); // "created" is a revision of its own
  now.add(61_000);
  await wiki.save(p.id, "2");
  assert.equal((await wiki.revisions(p.id)).length, 3);
  for (let i = 3; i < 12; i++) {
    now.add(86_400_000); // one a day
    await wiki.save(p.id, String(i));
  }
  assert.ok((await wiki.revisions(p.id)).length <= 5);
  wiki.setHistory({ minutes: 60, recent: 40, max: 120 });
  now.add(20 * 60_000);
  await wiki.save(p.id, "x");
  now.add(20 * 60_000);
  const before = (await wiki.revisions(p.id)).length;
  await wiki.save(p.id, "y");
  assert.equal((await wiki.revisions(p.id)).length, before);

  // From the wiki's settings (data key `settings`), read on load.
  await writeSettings(a, { historyMinutes: 2, historyRecent: 10, historyMax: 20, aiReview: true });
  const other = new Wiki(a, { now });
  await other.load();
  assert.deepEqual(other.history, { ms: 120_000, recent: 10, max: 20 });
  assert.equal(other.review, true);
});

test("trash and restore keep the page", async () => {
  const { wiki } = await setup();
  const p = await wiki.create({ title: "Old idea", folder: "Ideas", markdown: "x" });
  await wiki.trash(p.id);
  assert.equal(wiki.find("Old idea"), null);
  assert.equal(wiki.trashed().length, 1);
  assert.equal(wiki.trashed()[0].folder, "Ideas");
  await wiki.create({ title: "Old idea", markdown: "new" });
  const back = await wiki.untrash(p.id);
  assert.equal(back.title, "Old idea (restored)");
  assert.equal(back.folder, "Ideas");
  await wiki.destroy(p.id);
  assert.equal((await wiki.revisions(p.id)).length, 0);
});

test("search ranks titles over text, filters by type, tag (nested) and folder", async () => {
  const { wiki } = await setup();
  await wiki.create({ title: "Sourdough bread", folder: "Recipes/Baking",
    markdown: "---\ntype: Recipe\ntags: [food/bread]\n---\n\nFlour, water, salt." });
  await wiki.create({ title: "Saturday", markdown: "Baked sourdough bread today #kitchen" });
  const r = wiki.search("sourdough bread");
  assert.deepEqual(r.map((x) => x.page.title), ["Sourdough bread", "Saturday"]);
  assert.match(r[1].snippet, /sourdough bread/);
  assert.deepEqual(wiki.search("", { type: "recipe" }).map((x) => x.page.title), ["Sourdough bread"]);
  assert.deepEqual(wiki.search("", { tag: "#kitchen" }).map((x) => x.page.title), ["Saturday"]);
  assert.deepEqual(wiki.search("", { tag: "food" }).map((x) => x.page.title), ["Sourdough bread"]);
  assert.deepEqual(wiki.search("", { folder: "recipes" }).map((x) => x.page.title), ["Sourdough bread"]);
  assert.deepEqual(wiki.search("", { folder: "Recipes", subfolders: false }).length, 0);
  assert.deepEqual(wiki.list({ folder: "" , subfolders: false }).map((p) => p.title), ["Saturday"]);
});

test("load reads every page again (more than one batch); 0.1 records are at the top", async () => {
  const { a, wiki } = await setup();
  for (let i = 0; i < 520; i++) await a.dbInsert("pages", { title: `P${i}`, markdown: "", updated: i });
  await wiki.load();
  assert.equal(wiki.live().length, 520);
  assert.equal(wiki.find("P1").folder, "");
  assert.equal(wiki.find("P1").path, "P1");
});

test("folders: from pages and records, create, move, rename, delete", async () => {
  const { a, wiki } = await setup();
  const plan = await wiki.create({ title: "Plan", folder: " Projects / Thesis " });
  assert.equal(plan.folder, "Projects/Thesis");
  assert.equal(plan.path, "Projects/Thesis/Plan");
  await wiki.createFolder("Archive");
  await wiki.createFolder("projects/Thesis/Drafts"); // spelled as the wiki has it
  assert.deepEqual(wiki.folders(), ["Archive", "Projects", "Projects/Thesis", "Projects/Thesis/Drafts"]);
  await assert.rejects(wiki.createFolder("Bad:name"), /Folder "Bad:name"/);
  await assert.rejects(wiki.create({ title: "Plan", folder: "Archive" }), /already \(in Projects\/Thesis\)/);

  await wiki.move(plan.id, "Archive/2026");
  assert.equal(wiki.pages.get(plan.id).folder, "Archive/2026");
  assert.equal((await wiki.revisions(plan.id)).length, 1, "a move isn't a revision");
  assert.equal((await a.dbGet("pages", plan.id)).value.folder, "Archive/2026");

  await wiki.setBookmarks([{ kind: "folder", target: "Projects/Thesis", title: "Thesis" }]);
  const { path, moved } = await wiki.renameFolder("Projects", "Work/Projects");
  assert.equal(path, "Work/Projects");
  assert.equal(moved, 0);
  assert.deepEqual(wiki.folders(), ["Archive", "Archive/2026", "Work", "Work/Projects", "Work/Projects/Thesis",
    "Work/Projects/Thesis/Drafts"]);
  assert.equal(wiki.bookmarks()[0].target, "Work/Projects/Thesis");
  await assert.rejects(wiki.renameFolder("Work", "Work/Inner"), /inside itself/);
  await assert.rejects(wiki.renameFolder("Work", "Archive"), /already/);
  const r = await wiki.renameFolder("archive", "Old");
  assert.equal(r.moved, 1);
  assert.equal(wiki.pages.get(plan.id).folder, "Old/2026");
  await wiki.renameFolder("Old", "old"); // case only
  assert.equal(wiki.pages.get(plan.id).folder, "old/2026");

  await assert.rejects(wiki.deleteFolder("old"), /holds 1 page/);
  const del = await wiki.deleteFolder("old", { trashPages: true });
  assert.equal(del.trashed, 1);
  assert.ok(wiki.pages.get(plan.id).trashed);
  await wiki.deleteFolder("Work");
  assert.deepEqual(wiki.folders(), []);

  // Records come back on load.
  await wiki.createFolder("Reading");
  const again = new Wiki(a);
  await again.load();
  assert.deepEqual(again.folders(), ["Reading"]);
});

test("types: define (checked), in use, rename rewrites pages, delete keeps them", async () => {
  const { wiki } = await setup();
  assert.deepEqual(wiki.types(), []);
  await wiki.defineType(BOOK);
  await wiki.defineType({ name: "Person", icon: "👤", fields: [{ key: "email", kind: "url" }] });
  await assert.rejects(wiki.defineType({ name: "x", fields: [{ key: "Bad Key" }] }), /field key/);
  await assert.rejects(wiki.defineType({ name: "x", fields: [{ key: "a", kind: "colour" }] }), /kind is one of/);
  await assert.rejects(wiki.defineType({ name: "x", fields: [{ key: "a", kind: "select" }] }), /needs options/);
  await assert.rejects(wiki.defineType({ name: "x", color: "url(evil)" }), /colour/);
  // A change keeps what isn't given.
  const changed = await wiki.defineType({ name: "book", icon: "📚" });
  assert.equal(changed.icon, "📚");
  assert.equal(changed.fields.length, 4);
  assert.equal(changed.template, BOOK.template);

  await wiki.create({ title: "Dune", type: "Book" });
  await wiki.create({ title: "Ann Lee", type: "Person" });
  await wiki.create({ title: "Standup", type: "Meeting" });
  assert.deepEqual(wiki.typesInUse(), [
    { name: "Book", count: 1, defined: true },
    { name: "Meeting", count: 1, defined: false },
    { name: "Person", count: 1, defined: true },
  ]);

  const { updated } = await wiki.renameType("Person", "Contact", AI);
  assert.equal(updated, 1);
  assert.equal(wiki.find("Ann Lee").type, "Contact");
  assert.equal(wiki.find("Ann Lee").by, "ai");
  assert.ok(wiki.type("Contact") && !wiki.type("Person"));
  assert.equal(wiki.type("Book").fields.find((f) => f.key === "author").target, "Contact");
  await assert.rejects(wiki.renameType("Book", "contact"), /already/);
  // A type only pages use can be renamed too.
  await wiki.renameType("Meeting", "Meeting note");
  assert.equal(wiki.find("Standup").type, "Meeting note");

  const { pages } = await wiki.deleteType("Book");
  assert.equal(pages, 1);
  assert.equal(wiki.find("Dune").type, "Book");
  assert.equal(wiki.type("Book"), null);
});

test("0.1 type records still load", async () => {
  const { a, wiki } = await setup();
  await a.dataSet("type/cell line", { name: "Cell line", icon: "🧫", sections: ["Culture", "Notes"], fields: [
    { key: "atcc", label: "ATCC", url: "https://www.atcc.org/products/{}" },
    { key: "organism", kind: "link" }, { key: "markers", kind: "list" }, { key: "papers", kind: "links" },
    { key: "status", options: ["frozen", "growing"] }, { key: "passage", kind: "number" },
  ] });
  await wiki.load();
  const t = wiki.type("cell line");
  assert.deepEqual(t.fields.map((f) => `${f.key}:${f.kind}${f.multiple ? "[]" : ""}`),
    ["atcc:text", "organism:link", "markers:multiselect", "papers:link[]", "status:select", "passage:number"]);
  assert.equal(t.fields[0].url, "https://www.atcc.org/products/{}");
  assert.equal(t.template, "## Culture\n\n## Notes\n");
  const p = await wiki.create({ title: "HeLa", type: "Cell line" });
  assert.match(p.markdown, /atcc:/);
  assert.match(p.markdown, /## Culture/);
});

test("templates: pages in the templates folder; create from one", async () => {
  const { wiki } = await setup();
  await wiki.create({ title: "Meeting template", folder: "Templates",
    markdown: "---\ntags: [meeting]\n---\n\n# {{title}}\n\n{{date:dddd D MMMM YYYY}} at {{time}}\n\n## Actions\n" });
  await wiki.create({ title: "Elsewhere" });
  assert.deepEqual(wiki.templates().map((p) => p.title), ["Meeting template"]);
  assert.deepEqual(wiki.templates({ templatesFolder: "Nope" }), []);
  await wiki.defineType({ name: "Meeting", fields: [{ key: "attendees", kind: "link", multiple: true }],
    template: "type template" });
  const m = await wiki.create({ title: "Kickoff", folder: "Work", type: "Meeting", template: "Meeting template" });
  assert.equal(m.folder, "Work");
  assert.match(m.body, /^# Kickoff\n\nTuesday 17 November 2026 at 09:30\n\n## Actions/);
  assert.deepEqual(m.props, { tags: ["meeting"], type: "Meeting", attendees: [] });
  assert.doesNotMatch(m.markdown, /type template/);
  // body and properties
  const n = await wiki.create({ title: "Retro", type: "Meeting", body: "Short.", properties: { attendees: ["[[Ann]]"] } });
  assert.equal(n.body, "Short.");
  assert.deepEqual(n.props.attendees, ["[[Ann]]"]);
  await assert.rejects(wiki.create({ title: "X", template: "No such" }), /No template page/);
});

test("daily notes: today's page, made from the daily template in the daily folder", async () => {
  const { wiki } = await setup();
  await wiki.create({ title: "Daily template", folder: "Templates", markdown: "# {{date:dddd}}\n\n- [ ] \n" });
  const settings = { dailyFolder: "Journal", dailyFormat: "YYYY-MM-DD", dailyTemplate: "Daily template" };
  const day = await wiki.dailyNote("2026-11-18", settings);
  assert.equal(day.title, "2026-11-18");
  assert.equal(day.folder, "Journal");
  assert.equal(day.markdown, "# Wednesday\n\n- [ ] \n");
  assert.equal((await wiki.dailyNote("2026-11-18", settings)).id, day.id);
  assert.equal(await wiki.dailyNote("2026-11-19", settings, { create: false }), null);
  const nested = await wiki.dailyNote(new Date(2026, 0, 5), { ...settings, dailyFormat: "YYYY/MM/YYYY-MM-DD" });
  assert.equal(nested.title, "2026-01-05");
  assert.equal(nested.folder, "Journal/2026/01");
  // Templates and daily notes (in the folders of the wiki's settings) aren't orphans.
  assert.equal(wiki.orphans().length, 2); // the template is in the default Templates folder
  wiki.setSettings(settings);
  assert.deepEqual(wiki.orphans(), []);
  assert.equal((await wiki.dailyNote("2026-11-18")).id, day.id);
});

test("bookmarks: checked, deduplicated, saved and loaded", async () => {
  const { a, wiki } = await setup();
  await wiki.setBookmarks([
    { kind: "page", target: "id1", title: "Home" },
    { kind: "search", target: "tag:#idea" },
    { kind: "page", target: "id1" },
  ]);
  assert.deepEqual(wiki.bookmarks(), [{ kind: "page", target: "id1", title: "Home" },
    { kind: "search", target: "tag:#idea", title: "tag:#idea" }]);
  await assert.rejects(wiki.setBookmarks([{ kind: "planet", target: "x" }]), /kind/);
  assert.ok(a.events.some((e) => e.data.bookmarks));
  const again = new Wiki(a);
  await again.load();
  assert.equal(again.bookmarks().length, 2);
});

test("review mode: agents' changes wait as proposals; accept, reject", async () => {
  const { a, wiki, now } = await setup({ settings: { aiReview: true } });
  const page = await wiki.create({ title: "Garden", markdown: "line 1\nline 2\nline 3\n" });
  assert.equal(page.by, "you", "the user's own changes apply");

  // A new page.
  const c = await wiki.create({ title: "Compost", folder: "Garden", markdown: "Brown and green." }, AI);
  assert.equal(c.proposal, true);
  assert.equal(c.op, "create");
  assert.equal(wiki.find("Compost"), null);
  await assert.rejects(wiki.create({ title: "Compost" }, AI), /waiting for the user's review/);

  // Two edits by the same agent add up in one proposal.
  const s1 = await wiki.save(page.id, wiki.draft(page, AI).replace("line 1", "LINE 1"), AI);
  now.add(1000);
  const s2 = await wiki.save(page.id, wiki.draft(page, AI).replace("line 3", "LINE 3"), AI);
  assert.equal(s1.id, s2.id);
  assert.equal(wiki.pages.get(page.id).markdown, "line 1\nline 2\nline 3\n");
  assert.equal(wiki.proposals().length, 2);
  assert.equal(wiki.proposalsFor(page.id).length, 1);

  // Rename, move, trash.
  const r = await wiki.rename(page.id, "Vegetable garden", AI);
  const m = await wiki.move(page.id, "Outdoors", AI);
  const t = await wiki.trash(page.id, AI);
  assert.deepEqual([r.op, m.op, t.op], ["rename", "move", "trash"]);
  assert.equal(wiki.pages.get(page.id).title, "Garden");

  // Saved as data, so another device (or the panel) sees them.
  const other = new Wiki(a);
  await other.load();
  assert.equal(other.proposals().length, 5);

  // The user changed line 2 meanwhile: the AI's change merges.
  await wiki.save(page.id, "line 1\nmine\nline 3\n");
  const { page: merged, merged: didMerge } = await wiki.accept(s1.id);
  assert.equal(didMerge, true);
  assert.equal(merged.markdown, "LINE 1\nmine\nLINE 3\n");
  assert.equal(merged.by, "ai");
  assert.equal(merged.agent, "t_1");
  await wiki.accept(c.id);
  assert.equal(wiki.find("Compost").folder, "Garden");
  await wiki.accept(r.id);
  assert.equal(wiki.pages.get(page.id).title, "Vegetable garden");
  await wiki.accept(m.id);
  assert.equal(wiki.pages.get(page.id).folder, "Outdoors");
  await wiki.reject(t.id);
  assert.ok(!wiki.pages.get(page.id).trashed);
  assert.equal(wiki.proposals().length, 0);
  assert.equal((await a.dataList({ prefix: "proposal/" })).length, 0);
  await assert.rejects(wiki.accept(t.id), /No proposal/);
});

test("review mode: a change to lines the user changed too fails and stays", async () => {
  const { wiki } = await setup({ settings: { aiReview: true } });
  const page = await wiki.create({ title: "Plan", markdown: "a\nb\nc\n" });
  const p = await wiki.save(page.id, "a\nB by AI\nc\n", AI);
  await wiki.save(page.id, "a\nB by me\nc\n");
  await assert.rejects(wiki.accept(p.id), /changed since this was proposed, in the same lines \(around line 2\)/);
  assert.equal(wiki.proposals().length, 1);
  assert.equal(wiki.pages.get(page.id).markdown, "a\nB by me\nc\n");
  // Review off: agents write directly again.
  wiki.setSettings({ aiReview: false });
  const direct = await wiki.save(page.id, "x", AI);
  assert.equal(direct.markdown, "x");
});

test("prune keeps recent revisions and one per older day", () => {
  const day = 86_400_000;
  const revs = Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, at: i * day / 4 }));
  const drop = pruneRevisions(revs);
  assert.ok(revs.length - drop.length <= 120);
  assert.ok(!drop.includes("k199"));
  const small = pruneRevisions(revs, { recent: 5, max: 10 });
  assert.equal(revs.length - small.length, 10);
  for (const k of ["k199", "k198", "k197", "k196", "k195"]) assert.ok(!small.includes(k));
});
