// The panel shell's pure logic (panels/app/pure.js): fuzzy matching, search queries, trees, keys, saved tabs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allFolders, buildTree, effectiveKeys, filterResults, folderChain, fuzzy, hasTag, inFolder, keyFromEvent, keyLabel,
  markWords, movedFolderPath, normalizeKey, parseQuery, quickNoteTitle, rank, restoreTabs, routeKey, tagTree,
} from "../panels/app/pure.js";

const page = (title, extra = {}) => ({ id: title, title, folder: "", tags: [], type: null, updated: 0, created: 0,
  aliases: [], ...extra });

test("fuzzy: letters in order, word starts and runs first", () => {
  assert.equal(fuzzy("xyz", "Western blot"), null);
  assert.ok(fuzzy("wb", "Western blot"));
  assert.ok(fuzzy("wb", "Western blot").score > fuzzy("wb", "Swab").score);
  assert.ok(fuzzy("blot", "Western blot").score > fuzzy("blot", "B l o t t e r").score);
  assert.deepEqual(fuzzy("tp", "TP53").hits, [0, 1]);
  const ranked = rank("mdm", [page("TP53"), page("MDM2"), page("Mdm-like")], (p) => [p.title]);
  assert.deepEqual(ranked.map((r) => r.item.title), ["MDM2", "Mdm-like"]);
  // An alias matches too, a little below the title.
  const byAlias = rank("p53", [page("TP53", { aliases: ["p53"] })], (p) => [p.title, ...p.aliases]);
  assert.equal(byAlias[0].name, "p53");
});

test("parseQuery: tags, types, folders, quotes, negation", () => {
  const q = parseQuery('cell cycle #bio/genes type:Paper folder:"My notes/2026" -#draft tag:x');
  assert.deepEqual(q.words, ["cell", "cycle"]);
  assert.deepEqual(q.tags, ["bio/genes", "x"]);
  assert.deepEqual(q.notTags, ["draft"]);
  assert.deepEqual(q.types, ["Paper"]);
  assert.deepEqual(q.folders, ["My notes/2026"]);
  assert.deepEqual(parseQuery("").words, []);
  assert.deepEqual(parseQuery("-word").words, ["-word"]);
});

test("filters: nested tags and folders", () => {
  assert.ok(hasTag(["bio/genes"], "bio"));
  assert.ok(hasTag(["Bio"], "#bio"));
  assert.ok(!hasTag(["biology"], "bio"));
  assert.ok(inFolder("Projects/Thesis", "projects"));
  assert.ok(!inFolder("Projects2", "Projects"));
  assert.ok(inFolder("", ""));
  const rows = [
    { page: page("A", { tags: ["bio/genes"], folder: "Work", type: "Paper" }) },
    { page: page("B", { tags: ["bio", "draft"], folder: "Home" }) },
    { page: page("C", { tags: [] }) },
  ];
  assert.deepEqual(filterResults(rows, parseQuery("#bio")).map((r) => r.page.title), ["A", "B"]);
  assert.deepEqual(filterResults(rows, parseQuery("#bio -#draft")).map((r) => r.page.title), ["A"]);
  assert.deepEqual(filterResults(rows, parseQuery("folder:home")).map((r) => r.page.title), ["B"]);
  assert.deepEqual(filterResults(rows, parseQuery("type:paper")).map((r) => r.page.title), ["A"]);
});

test("markWords: marks words in text, not in tags, escaped", () => {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  assert.equal(markWords("Cell <cycle>", ["cell"], esc), "<mark>Cell</mark> &lt;cycle&gt;");
  assert.equal(markWords("a b", [], esc), "a b");
});

test("folders and the tree", () => {
  const pages = [page("A", { folder: "Projects/Thesis" }), page("B"), page("C", { folder: "Projects", updated: 5 }),
    page("D", { folder: "Projects", updated: 9 })];
  assert.deepEqual(allFolders(pages, ["Inbox", "Projects/old"]), ["Inbox", "Projects", "Projects/old",
    "Projects/Thesis"]);
  const tree = buildTree(pages, ["Inbox"], "modified");
  assert.deepEqual(tree.folders.map((f) => f.name), ["Inbox", "Projects"]);
  const projects = tree.folders[1];
  assert.deepEqual(projects.pages.map((p) => p.title), ["D", "C"]);
  assert.equal(projects.count, 3);
  assert.deepEqual(projects.folders.map((f) => f.path), ["Projects/Thesis"]);
  assert.deepEqual(tree.pages.map((p) => p.title), ["B"]);
  assert.equal(tree.count, 4);
  assert.deepEqual(folderChain("a/b/c"), ["a", "a/b", "a/b/c"]);
  assert.equal(movedFolderPath("a/b", "c"), "c/b");
  assert.equal(movedFolderPath("a/b", ""), "b");
  assert.equal(movedFolderPath("a", "a/x"), null);
  assert.equal(movedFolderPath("a/b", "a"), null);
});

test("tagTree: nested with counts per page", () => {
  const tree = tagTree([page("A", { tags: ["bio/genes", "bio"] }), page("B", { tags: ["bio/proteins"] }),
    page("C", { tags: ["idea"] })]);
  assert.deepEqual(tree.map((t) => [t.name, t.count]), [["bio", 2], ["idea", 1]]);
  assert.deepEqual(tree[0].children.map((t) => [t.tag, t.count]), [["bio/genes", 1], ["bio/proteins", 1]]);
});

test("keys: from events, normalized, labels, clashes", () => {
  assert.equal(keyFromEvent({ key: "o", code: "KeyO", ctrlKey: true }), "ctrl+o");
  assert.equal(keyFromEvent({ key: "O", code: "KeyO", ctrlKey: true, shiftKey: true }), "ctrl+shift+o");
  assert.equal(keyFromEvent({ key: "\\", code: "Backslash", ctrlKey: true }), "ctrl+\\");
  assert.equal(keyFromEvent({ key: "Control", code: "ControlLeft", ctrlKey: true }), null);
  assert.equal(keyFromEvent({ key: "Tab", code: "Tab", ctrlKey: true }), "ctrl+tab");
  assert.equal(keyFromEvent({ key: "F2", code: "F2" }), "f2");
  assert.equal(normalizeKey("Shift+Ctrl+K"), "ctrl+shift+k");
  assert.equal(normalizeKey("cmd+p"), "ctrl+p");
  assert.equal(keyLabel("ctrl+shift+\\"), "Ctrl+Shift+\\");
  assert.equal(keyLabel("alt+arrowleft"), "Alt+←");
  const cmds = [{ id: "a", key: "ctrl+o" }, { id: "b", key: "ctrl+p" }, { id: "c" }];
  const { byId, byKey } = effectiveKeys(cmds, { b: "", c: "Ctrl+O" });
  assert.equal(byId.get("b"), "");
  assert.deepEqual(byKey.get("ctrl+o"), ["a", "c"]);
});

test("tabs: saved state back, 0.1's state, broken parts dropped", () => {
  const r = restoreTabs({ tabs: [{ route: { view: "page", id: "x" }, back: [{ view: "home" }, null], fwd: "x" },
    { route: null }, { route: { view: "trash" } }], active: 5 });
  assert.equal(r.tabs.length, 2);
  assert.deepEqual(r.tabs[0].back, [{ view: "home" }]);
  assert.deepEqual(r.tabs[0].fwd, []);
  assert.equal(r.active, 1);
  assert.deepEqual(restoreTabs({ page: "p1", mode: "edit" }).tabs[0].route, { view: "page", id: "p1", mode: "edit" });
  assert.deepEqual(restoreTabs(null), { tabs: [], active: 0 });
  assert.equal(routeKey({ view: "page", id: "a", mode: "edit" }), routeKey({ view: "page", id: "a" }));
  assert.notEqual(routeKey({ view: "page", id: "a" }), routeKey({ view: "page", id: "b" }));
});

test("quickNoteTitle: no colons, numbered when taken", () => {
  const d = new Date(2026, 10, 18, 9, 5);
  assert.equal(quickNoteTitle(d), "Note 2026-11-18 09.05");
  const taken = new Set(["Note 2026-11-18 09.05"]);
  assert.equal(quickNoteTitle(d, (t) => taken.has(t)), "Note 2026-11-18 09.05 (2)");
});
