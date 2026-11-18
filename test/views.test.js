// The views' pure logic (shared/query.js, shared/tasks.js, panels/views/force.js) and their tools (backend/view-tools.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph, Simulation } from "../panels/views/force.js";
import { healthReport } from "../panels/views/health.js";
import { guessFields, keyFromLabel } from "../panels/views/types.js";
import { monthDays } from "../panels/views/database.js";
import { dayKey, describeSource, editValue, fieldsOf, groupPages, matches, moveChange, normalizeOp, normalizeView,
  operandDay, runView, saveView, listViews, findView, deleteView, tableText, valueOf, dayOf } from "../shared/query.js";
import { allTasks, dueBucket, groupTasks, parseTasks, setTaskDue, sortTasks, taskLabel, toggleTask } from "../shared/tasks.js";
import { Wiki } from "../shared/wiki.js";
import { memoryAdapter } from "./memory.js";

const AGENT = { "layr/caller": { kind: "agent", plugin: "claude", label: "t_abc" } };
const NOW = new Date(2026, 10, 18, 12).getTime(); // 2026-11-18, local noon

async function sampleWiki() {
  const wiki = new Wiki(memoryAdapter(), { who: "you", now: () => NOW });
  const mk = (title, markdown, folder = "") => wiki.create({ title, markdown, folder });
  await mk("Smith 2020 Kinases", "---\ntype: Paper\nyear: 2020\nstatus: read\nauthors: [Smith, Jones]\n" +
    "published: 2020-03-01\n---\n\nAbout [[TP53]] and [[MDM2]]. #review", "Projects/Thesis");
  await mk("Lee 2024 Gels", "---\ntype: Paper\nyear: 2024\nstatus: to read\nauthors: [Lee]\npublished: 2024-06-10\n" +
    "---\n\nGels. [[TP53]]", "Projects/Thesis/Reading");
  await mk("Kim 2022 Mice", "---\ntype: Paper\nyear: 2022\nstatus: reading\nread: true\n---\n\nMice.", "Projects");
  await mk("TP53", "---\ntype: Gene\n---\n\nGuardian. Linked from papers.\n\n- [ ] order antibody 📅 2026-11-17 ⏫\n" +
    "- [x] read review\n- [ ] write summary due:: 2026-11-20\n  - [ ] intro #writing\n  - [ ] methods\n", "");
  await mk("Ideas", "Loose ideas #idea\n\n```\n- [ ] not a task\n```\n\n> - [ ] quoted task\n");
  return wiki;
}

test("query: op spellings, values and filters by kind", () => {
  assert.equal(normalizeOp("="), "is");
  assert.equal(normalizeOp("is not"), "isNot");
  assert.equal(normalizeOp(">"), "gt");
  assert.equal(normalizeOp("within last"), "within");
  assert.equal(normalizeOp("notEmpty"), "notEmpty");
  assert.ok(matches("text", "[[Homo sapiens]]", "is", "homo sapiens"));
  assert.ok(matches("text", "Reading", "contains", "EAD"));
  assert.ok(matches("multiselect", ["Smith", "Jones"], "is", "jones"));
  assert.ok(matches("multiselect", ["Smith"], "notContains", "lee"));
  assert.ok(matches("tags", [], "empty"));
  assert.ok(matches("number", 2022, "gt", "2021"));
  assert.ok(!matches("number", null, "gt", 1));
  assert.ok(matches("checkbox", true, "is", "yes"));
  assert.ok(matches("checkbox", null, "is", false));
  assert.ok(matches("date", "2026-11-01", "before", "2026-11-02"));
  assert.ok(matches("date", "2026-11-01", "after", "2026-10-31"));
  assert.ok(matches("datetime", NOW - 3 * 86400000, "within", 7, NOW));
  assert.ok(!matches("datetime", NOW - 9 * 86400000, "within", 7, NOW));
  assert.ok(matches("date", "2026-11-18", "is", "today", NOW));
  assert.equal(dayKey(operandDay("+2", NOW)), "2026-11-20");
  assert.equal(dayKey(operandDay("yesterday", NOW)), "2026-11-17");
});

test("query: a view's source, filters and multi-field sort", async () => {
  const wiki = await sampleWiki();
  const titles = (v) => runView(wiki, normalizeView(v), { now: NOW }).map((p) => p.title);
  assert.deepEqual(titles({ source: { type: "paper" } }), ["Kim 2022 Mice", "Lee 2024 Gels", "Smith 2020 Kinases"]);
  assert.deepEqual(titles({ source: { folder: "Projects/Thesis" } }), ["Lee 2024 Gels", "Smith 2020 Kinases"]);
  assert.deepEqual(titles({ source: { folder: "projects" }, sort: [{ field: "year", dir: "desc" }] }),
    ["Lee 2024 Gels", "Kim 2022 Mice", "Smith 2020 Kinases"]);
  assert.deepEqual(titles({ source: { tag: "review" } }), ["Smith 2020 Kinases"]);
  assert.deepEqual(titles({ source: { query: "gels" } }), ["Lee 2024 Gels"]);
  assert.deepEqual(titles({ source: { type: "Paper" }, filters: [{ field: "status", op: "is not", value: "read" }] }),
    ["Kim 2022 Mice", "Lee 2024 Gels"]);
  assert.deepEqual(titles({ filters: [{ field: "authors", op: "contains", value: "smi" }] }), ["Smith 2020 Kinases"]);
  assert.deepEqual(titles({ filters: [{ field: "published", op: "after", value: "2021-01-01" }] }), ["Lee 2024 Gels"]);
  assert.deepEqual(titles({ filters: [{ field: "backlinks", op: ">", value: 0 }] }), ["TP53"]);
  assert.deepEqual(titles({ filters: [{ field: "type", op: "empty" }] }), ["Ideas"]);
  assert.equal(titles({ filters: [{ field: "year", op: "is", value: "" }] }).length, 5, "a filter without a value yet");
  assert.deepEqual(titles({ filters: [{ field: "read", op: "is", value: true }] }), ["Kim 2022 Mice"]);
  // Sorting by status then year: empty values last, ties broken by the next field.
  assert.deepEqual(titles({ sort: [{ field: "status", dir: "asc" }, { field: "year", dir: "desc" }] }),
    ["Smith 2020 Kinases", "Kim 2022 Mice", "Lee 2024 Gels", "Ideas", "TP53"]);
  const fields = fieldsOf(wiki, wiki.live());
  assert.equal(fields.find((f) => f.key === "year").kind, "number");
  assert.equal(fields.find((f) => f.key === "published").kind, "date");
  assert.equal(fields.find((f) => f.key === "authors").kind, "multiselect");
  assert.equal(fields.find((f) => f.key === "read").kind, "checkbox");
  assert.equal(valueOf(wiki, wiki.find("TP53"), "backlinks"), 2);
  assert.equal(dayOf(wiki, wiki.find("Lee 2024 Gels"), "published"), "2024-06-10");
  assert.equal(describeSource({ folder: "Projects", type: "Paper", tag: "x" }), "Folder Projects · Type Paper · #x");
});

test("query: groups for boards and what a move changes", async () => {
  const wiki = await sampleWiki();
  const papers = runView(wiki, normalizeView({ source: { type: "Paper" } }));
  const fields = fieldsOf(wiki, papers).map((f) => (f.key === "status" ? { ...f, kind: "select",
    options: ["to read", "reading", "read"] } : f));
  const groups = groupPages(wiki, papers, "status", fields);
  assert.deepEqual(groups.map((g) => [g.label, g.pages.length]), [["to read", 1], ["reading", 1], ["read", 1],
    ["No status", 0]]);
  const byAuthor = groupPages(wiki, papers, "authors", fields);
  assert.deepEqual(byAuthor.map((g) => g.label), ["Jones", "Lee", "Smith", "No authors"]);
  const byFolder = groupPages(wiki, papers, "folder", fields);
  assert.deepEqual(byFolder.map((g) => g.value).sort(), ["Projects", "Projects/Thesis", "Projects/Thesis/Reading"]);
  const smith = wiki.find("Smith 2020 Kinases");
  assert.deepEqual(moveChange(wiki, smith, "status", "read", "reading", fields), { props: { status: "reading" } });
  assert.deepEqual(moveChange(wiki, smith, "status", "read", null, fields), { props: { status: null } });
  assert.deepEqual(moveChange(wiki, smith, "authors", "Jones", "Lee", fields), { props: { authors: ["Smith", "Lee"] } });
  assert.deepEqual(moveChange(wiki, smith, "folder", "Projects/Thesis", "Archive", fields), { folder: "Archive" });
  assert.equal(moveChange(wiki, smith, "updated", null, "x", fields), null);
  assert.equal(editValue({ kind: "number" }, "42"), 42);
  assert.equal(editValue({ kind: "link" }, "Mouse"), "[[Mouse]]");
  assert.deepEqual(editValue({ kind: "multiselect" }, "a, b,"), ["a", "b"]);
  assert.equal(editValue({ kind: "text" }, "  "), null);
  assert.equal(editValue({ kind: "checkbox" }, false), false);
  const text = tableText(wiki, papers, ["title", "year", "authors"], fields);
  assert.match(text, /\| Title \| year \| authors \|/);
  assert.match(text, /\| \[\[Smith 2020 Kinases\]\] \| 2020 \| Smith, Jones \|/);
});

test("query: saved views are data view/<id>", async () => {
  const wiki = await sampleWiki();
  const v = await saveView(wiki, { name: "Reading list", source: { type: "Paper" }, layout: "board", groupBy: "status" });
  assert.equal(wiki.a.kv.get(`view/${v.id}`).value.name, "Reading list");
  assert.ok(wiki.a.events.some((e) => e.topic === "wiki:changed" && e.data.views));
  assert.equal((await listViews(wiki.a)).length, 1);
  assert.equal((await findView(wiki.a, "reading LIST")).id, v.id);
  assert.equal((await findView(wiki.a, v.id)).layout, "board");
  await deleteView(wiki, v.id);
  assert.equal((await listViews(wiki.a)).length, 0);
  assert.equal(normalizeView({ layout: "nope", filters: [{ field: "a", op: "!=" }, { op: "is" }] }).layout, "table");
  assert.deepEqual(normalizeView({ filters: [{ field: "a", op: "!=" }, { op: "is" }] }).filters,
    [{ field: "a", op: "isNot", value: "" }]);
});

test("tasks: parsing, nesting, due dates, priorities; code and properties left out", () => {
  const md = "---\ntags: [x]\n---\n\n# Plan\n\n- [ ] order antibody 📅 2026-11-17 ⏫\n- [x] read review\n" +
    "- [ ] write summary due:: 2026-11-20\n  - [ ] intro #writing\n    - [/] in progress\n  - [-] dropped\n" +
    "- plain item\n  - [ ] under a plain item\n\nText.\n\n```\n- [ ] in code\n```\n> - [ ] quoted\n1. [ ] numbered";
  const tasks = parseTasks(md);
  assert.deepEqual(tasks.map((t) => t.label), ["order antibody", "read review", "write summary", "intro #writing",
    "in progress", "dropped", "under a plain item", "quoted", "numbered"]);
  const [order, review, summary, intro, prog, dropped, under] = tasks;
  assert.equal(order.line, 6);
  assert.equal(order.due, "2026-11-17");
  assert.equal(order.priority, "high");
  assert.equal(order.heading, "Plan");
  assert.ok(review.done);
  assert.equal(summary.due, "2026-11-20");
  assert.equal(intro.parent, summary.line);
  assert.equal(intro.depth, 1);
  assert.deepEqual(intro.tags, ["writing"]);
  assert.equal(prog.parent, intro.line);
  assert.equal(prog.depth, 2);
  assert.ok(!prog.done && !prog.cancelled);
  assert.ok(dropped.cancelled);
  assert.equal(under.parent, null);
  assert.equal(taskLabel("call 🔼 📅 2026-01-02 back"), "call back");
});

test("tasks: check off, uncheck, stale line numbers, due dates written", () => {
  const md = "# A\n\n- [ ] one\n- [x] two\n";
  const checked = toggleTask(md, 2);
  assert.equal(checked, "# A\n\n- [x] one\n- [x] two\n");
  assert.equal(toggleTask(checked, 3, { done: false }), "# A\n\n- [x] one\n- [ ] two\n");
  // The page got a line above the task since it was read: the task is found by its text.
  assert.equal(toggleTask("New line\n" + md, 2, { text: "one" }), "New line\n# A\n\n- [x] one\n- [x] two\n");
  assert.throws(() => toggleTask(md, 0), /isn't on the page/);
  assert.equal(setTaskDue(md, 2, "2026-12-01"), "# A\n\n- [ ] one 📅 2026-12-01\n- [x] two\n");
  assert.equal(setTaskDue("- [ ] a 📅 2026-01-01 ⏫", 0, null), "- [ ] a ⏫");
  assert.equal(dueBucket("2026-11-17", "2026-11-18"), "overdue");
  assert.equal(dueBucket("2026-11-19", "2026-11-18"), "tomorrow");
  assert.equal(dueBucket("2026-11-24", "2026-11-18"), "week");
  assert.equal(dueBucket(null), "none");
});

test("tasks: across the wiki, filtered and grouped", async () => {
  const wiki = await sampleWiki();
  const today = "2026-11-18";
  const open = allTasks(wiki, { today });
  assert.deepEqual(open.map((t) => t.label).sort(), ["intro #writing", "methods", "order antibody", "quoted task",
    "write summary"]);
  assert.equal(allTasks(wiki, { status: "done", today }).length, 1);
  assert.equal(allTasks(wiki, { status: "all", today }).length, 6);
  assert.deepEqual(allTasks(wiki, { due: "overdue", today }).map((t) => t.label), ["order antibody"]);
  assert.deepEqual(allTasks(wiki, { due: "week", today }).map((t) => t.label), ["order antibody", "write summary"]);
  // A tag on the page (here inline, in a task) takes all its tasks.
  assert.equal(allTasks(wiki, { tag: "writing", today }).length, 4);
  assert.deepEqual(allTasks(wiki, { tag: "idea", today }).map((t) => t.label), ["quoted task"]);
  assert.deepEqual(allTasks(wiki, { page: "ideas", today }).map((t) => t.label), ["quoted task"]);
  assert.deepEqual(sortTasks(open).map((t) => t.label).slice(0, 2), ["order antibody", "write summary"]);
  assert.deepEqual(groupTasks(open, "due", today).map((g) => g.label), ["Overdue", "Next 7 days", "No date"]);
  assert.deepEqual(groupTasks(open, "page", today).map((g) => g.label), ["Ideas", "TP53"]);
  // Checking a task off through the model changes only that line.
  const tp53 = wiki.find("TP53");
  const t = open.find((x) => x.label === "methods");
  await wiki.save(tp53.id, toggleTask(tp53.markdown, t.line, { text: t.text }));
  assert.match(wiki.find("TP53").markdown, /  - \[x\] methods/);
  assert.equal(allTasks(wiki, { today }).length, 4);
});

test("graph: the force simulation settles and keeps linked nodes closer than unlinked ones", () => {
  const n = 400;
  const nodes = Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  const edges = [];
  for (let i = 1; i < n; i++) edges.push([i, Math.floor((i - 1) / 3)]); // a tree
  const sim = new Simulation(nodes, edges);
  const t0 = Date.now();
  sim.run(300);
  assert.ok(Date.now() - t0 < 4000, "300 ticks of 400 nodes should be quick");
  assert.ok(sim.alpha < 0.01);
  for (const nd of nodes) assert.ok(Number.isFinite(nd.x) && Number.isFinite(nd.y));
  const d = (a, b) => Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
  const linked = edges.reduce((s, [a, b]) => s + d(a, b), 0) / edges.length;
  let far = 0;
  for (let i = 0; i < 200; i++) far += d(i, n - 1 - i);
  assert.ok(linked < far / 200, `linked ${linked} vs random ${far / 200}`);
});

test("tools: tasks, views, query", async () => {
  const { createBackend } = await import("../backend/core.js");
  const adapter = memoryAdapter();
  const backend = createBackend({ adapter, session: async () => null, settings: async () => ({ mirror: false }) });
  const call = (name, args) => backend.call(name, args, AGENT);
  await call("create", { title: "TP53", type: "Gene", markdown: "- [ ] order antibody 📅 2026-11-17\n- [x] done one\n" });
  await call("create", { title: "Smith 2020", type: "Paper", properties: { year: 2020, status: "read" } });
  await call("create", { title: "Lee 2024", type: "Paper", properties: { year: 2024, status: "to read" } });
  const tasks = await call("tasks", {});
  assert.match(tasks, /1 open tasks/);
  assert.match(tasks, /\[\[TP53\]\]\n- \[ \] order antibody · due 2026-11-17 \(line \d+\)/);
  assert.match(await call("tasks", { status: "done" }), /- \[x\] done one/);
  assert.match(await call("tasks", { page: "Nothing like it" }).catch((e) => e.message), /No page/);
  assert.match(await call("views", {}), /No saved views yet/);
  const q = await call("query", { source: { type: "Paper" }, sort: [{ field: "year", dir: "desc" }],
    columns: ["title", "year", "status"] });
  assert.match(q, /→ 2 pages/);
  assert.ok(q.indexOf("Lee 2024") < q.indexOf("Smith 2020"));
  assert.match(await call("query", { filters: [{ field: "status", op: "is", value: "read" }] }), /\[\[Smith 2020\]\]/);
  const wiki = await backend.getWiki();
  await saveView(wiki, { name: "To read", source: { type: "Paper" }, filters: [{ field: "status", op: "is",
    value: "to read" }], columns: ["title", "year"] });
  assert.match(await call("views", {}), /- To read \(id \w+, table, 1 pages\): Type Paper\n {2}filters: status is "to read"/);
  const saved = await call("query", { view: "to read" });
  assert.match(saved, /\| \[\[Lee 2024\]\] \| 2024 \|/);
  assert.doesNotMatch(saved, /Smith/);
  await assert.rejects(call("query", { view: "nope" }), /No view "nope"\. Saved views: To read/);
  assert.ok(["tasks", "views", "query"].every((t) => backend.tools.has(t)));
});

test("graph: built from the wiki, narrowed by folder, around a page, with missing pages", async () => {
  const wiki = await sampleWiki();
  const titles = (g) => g.nodes.map((n) => n.title).sort();
  const all = buildGraph(wiki);
  assert.equal(all.nodes.length, 5);
  assert.equal(all.edges.length, 2); // both papers link TP53 (MDM2 doesn't exist)
  assert.equal(all.nodes.find((n) => n.title === "TP53").degree, 2);
  assert.deepEqual(titles(buildGraph(wiki, { orphans: false })), ["Lee 2024 Gels", "Smith 2020 Kinases", "TP53"]);
  assert.deepEqual(titles(buildGraph(wiki, { folder: "Projects/Thesis" })), ["Lee 2024 Gels", "Smith 2020 Kinases"]);
  const withMissing = buildGraph(wiki, { missing: true });
  assert.ok(withMissing.nodes.some((n) => n.ghost && n.title === "MDM2"));
  const lee = wiki.find("Lee 2024 Gels").id;
  assert.deepEqual(titles(buildGraph(wiki, { center: lee, depth: 1 })), ["Lee 2024 Gels", "TP53"]);
  assert.deepEqual(titles(buildGraph(wiki, { center: lee, depth: 2 })), ["Lee 2024 Gels", "Smith 2020 Kinases", "TP53"]);
});

test("graph: 2000 pages lay out quickly (Barnes-Hut)", () => {
  const n = 2000;
  const nodes = Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  const edges = [];
  for (let i = 1; i < n; i++) edges.push([i, (i * 7919) % i]);
  const sim = new Simulation(nodes, edges);
  const t0 = performance.now();
  sim.run(30);
  const perTick = (performance.now() - t0) / 30;
  assert.ok(perTick < 40, `a tick of 2000 nodes took ${perTick.toFixed(1)} ms`);
});

test("health: broken links, duplicate names, empty pages, missing types in a folder", async () => {
  const wiki = await sampleWiki();
  await wiki.create({ title: "Blank", markdown: "---\ntype: Note\n---\n\n%% nothing yet %%\n" });
  await wiki.create({ title: "p53 notes", markdown: "---\naliases: [TP53]\n---\n\nNotes." });
  await wiki.create({ title: "Wu 2019", markdown: "---\ntype: Paper\n---\nx", folder: "Projects/Thesis" });
  await wiki.create({ title: "Ng 2021", markdown: "---\ntype: Paper\n---\ny", folder: "Projects/Thesis" });
  await wiki.create({ title: "Unsorted", markdown: "no type", folder: "Projects/Thesis" });
  const r = healthReport(wiki);
  assert.deepEqual(r.wanted.map((w) => w.title), ["MDM2"]);
  assert.deepEqual(r.duplicates.map((d) => [d.name, d.pages.length]), [["TP53", 2]]);
  assert.deepEqual(r.empty.map((p) => p.title), ["Blank"]);
  assert.deepEqual(r.untyped.map((u) => [u.page.title, u.type]), [["Unsorted", "Paper"]]);
  assert.ok(r.orphans.some((p) => p.title === "Ideas"));
});

test("types and calendar helpers", async () => {
  const wiki = await sampleWiki();
  const papers = wiki.live().filter((p) => p.type === "Paper");
  const fields = Object.fromEntries(guessFields(papers).map((f) => [f.key, f.kind]));
  assert.deepEqual(fields, { year: "number", status: "text", authors: "multiselect", published: "date", read: "checkbox" });
  assert.equal(keyFromLabel("Due date (UTC)"), "due_date_utc");
  assert.equal(keyFromLabel("Année"), "annee");
  const days = monthDays(new Date(2026, 10, 1)); // November 2026 starts on a Sunday
  assert.equal(days.length % 7, 0);
  assert.equal(dayKey(days[0]), "2026-10-26");
  assert.equal(dayKey(days[days.length - 1]), "2026-12-06");
});
