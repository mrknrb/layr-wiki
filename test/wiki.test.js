import assert from "node:assert/strict";
import { test } from "node:test";
import { COALESCE_MS, pruneRevisions, undoTarget, Wiki } from "../shared/wiki.js";
import { memoryAdapter } from "./memory.js";

function clock(start = Date.UTC(2026, 10, 17, 9)) {
  let t = start;
  const now = () => t;
  now.add = (ms) => (t += ms);
  return now;
}

async function setup() {
  const a = memoryAdapter();
  const now = clock();
  const wiki = new Wiki(a, { who: "you", device: "d1", now });
  return { a, now, wiki };
}

test("create from a type's template, find by title and alias", async () => {
  const { wiki } = await setup();
  const gene = await wiki.create({ title: "TP53", type: "Gene" });
  assert.equal(gene.type, "Gene");
  assert.match(gene.markdown, /## Function/);
  await wiki.setProps(gene.id, { aliases: ["p53"] });
  assert.equal(wiki.find("tp53").id, gene.id);
  assert.equal(wiki.resolve("P53").id, gene.id);
  await assert.rejects(wiki.create({ title: "tp53" }), /already/);
  await assert.rejects(wiki.create({ title: "a|b" }), /can't hold/);
});

test("backlinks, wanted pages, orphans, unlinked mentions", async () => {
  const { wiki } = await setup();
  const a = await wiki.create({ title: "TP53", markdown: "Regulated by [[MDM2]]. See [[Apoptosis]]." });
  const b = await wiki.create({ title: "MDM2", markdown: "An E3 ligase for TP53." });
  const c = await wiki.create({ title: "Home", markdown: "Start: [[TP53]]" });
  assert.deepEqual(wiki.backlinks(b.id).map((p) => p.title), ["TP53"]);
  assert.deepEqual(wiki.backlinks(a.id).map((p) => p.title), ["Home"]);
  assert.deepEqual(wiki.wanted().map((w) => w.title), ["Apoptosis"]);
  assert.deepEqual(wiki.orphans().map((p) => p.title), []);
  assert.deepEqual(wiki.unlinkedMentions(a.id).map((p) => p.title), ["MDM2"]);
  assert.equal(c.links[0], "TP53");
});

test("properties with links count as links", async () => {
  const { wiki } = await setup();
  const mouse = await wiki.create({ title: "Mouse" });
  await wiki.create({ title: "Trp53", markdown: '---\ntype: Gene\norganism: "[[Mouse]]"\n---\n\nText' });
  assert.deepEqual(wiki.backlinks(mouse.id).map((p) => p.title), ["Trp53"]);
});

test("rename fixes links everywhere", async () => {
  const { wiki } = await setup();
  const a = await wiki.create({ title: "p53" });
  const b = await wiki.create({ title: "Notes", markdown: "[[p53]] and [[P53|it]] and [[p53#Function]]" });
  const { updated } = await wiki.rename(a.id, "TP53", { by: "ai", agent: "t_1" });
  assert.equal(updated, 1);
  assert.equal(wiki.pages.get(b.id).markdown, "[[TP53]] and [[TP53|it]] and [[TP53#Function]]");
  assert.equal(wiki.pages.get(b.id).by, "ai");
  assert.equal(wiki.find("TP53").id, a.id);
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
  await wiki.save(p.id, "ai 1", { by: "ai", agent: "t_1" });
  now.add(1000);
  await wiki.save(p.id, "ai 2", { by: "ai", agent: "t_1" });
  revs = await wiki.revisions(p.id);
  assert.deepEqual(revs.map((r) => `${r.by}:${r.markdown}`), ["ai:ai 2", "you:v3", "you:v1"]);
  assert.equal(undoTarget(revs).markdown, "v3");
  await wiki.restore(p.id);
  assert.equal(wiki.pages.get(p.id).markdown, "v3");
  now.add(COALESCE_MS + 1);
  await wiki.save(p.id, "later");
  assert.equal((await wiki.revisions(p.id)).length, 5);
});

test("trash and restore keep the page", async () => {
  const { wiki } = await setup();
  const p = await wiki.create({ title: "Old idea", markdown: "x" });
  await wiki.trash(p.id);
  assert.equal(wiki.find("Old idea"), null);
  assert.equal(wiki.trashed().length, 1);
  await wiki.create({ title: "Old idea", markdown: "new" });
  const back = await wiki.untrash(p.id);
  assert.equal(back.title, "Old idea (restored)");
  await wiki.destroy(p.id);
  assert.equal((await wiki.revisions(p.id)).length, 0);
});

test("search ranks titles over text, filters by type and tag", async () => {
  const { wiki } = await setup();
  await wiki.create({ title: "Western blot", type: "Method", markdown: "---\ntype: Method\ntags: [protein]\n---\n\nSDS-PAGE then transfer." });
  await wiki.create({ title: "Gel notes", markdown: "Ran a western blot today #lab" });
  const r = wiki.search("western blot");
  assert.deepEqual(r.map((x) => x.page.title), ["Western blot", "Gel notes"]);
  assert.match(r[1].snippet, /western blot/);
  assert.deepEqual(wiki.search("", { type: "method" }).map((x) => x.page.title), ["Western blot"]);
  assert.deepEqual(wiki.search("", { tag: "#lab" }).map((x) => x.page.title), ["Gel notes"]);
});

test("load reads every page again (more than one batch)", async () => {
  const { a, wiki } = await setup();
  for (let i = 0; i < 520; i++) await a.dbInsert("pages", { title: `P${i}`, markdown: "", updated: i });
  await wiki.load();
  assert.equal(wiki.live().length, 520);
});

test("custom types", async () => {
  const { wiki } = await setup();
  await wiki.defineType({ name: "Cell line", icon: "🧫", fields: [{ key: "atcc", label: "ATCC", url: "https://www.atcc.org/products/{}" }], sections: ["Culture"] });
  const p = await wiki.create({ title: "HeLa", type: "Cell line" });
  assert.match(p.markdown, /atcc:/);
  assert.match(p.markdown, /## Culture/);
  await assert.rejects(wiki.defineType({ name: "x", fields: [{ key: "Bad Key" }] }), /field key/);
});

test("prune keeps recent revisions and one per older day", () => {
  const day = 86_400_000;
  const revs = Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, at: i * day / 4 }));
  const drop = pruneRevisions(revs);
  assert.ok(revs.length - drop.length <= 120);
  assert.ok(!drop.includes("k199"));
});
