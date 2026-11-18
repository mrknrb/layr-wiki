// Tasks: the checklist items of every page (`- [ ] buy agarose`, `- [x] done`), for the Tasks view and the `tasks`
// tool. Pure; tested in test/views.test.js.
//
// The convention (the one Obsidian's Tasks and Dataview plugins read, so a vault opened there means the same):
// - a task is a list item with a box: `- [ ] text`, also `* [ ]`, `+ [ ]`, `1. [ ]`, inside a quote or callout
//   (`> - [ ]`) and indented under another item (nested). `[x]`/`[X]` is done, `[-]` cancelled, any other mark
//   (`[/]` in progress, `[>]`, `[?]`) still open;
// - a due date is `📅 2026-11-20` (written so) or `due:: 2026-11-20` / `[due:: 2026-11-20]`;
// - a priority is optional: 🔺 highest, ⏫ high, 🔼 medium, 🔽 low, ⏬ lowest.
// Lines in code blocks and in the properties block are not tasks.
import { inlineTags, keyOf, maskCode } from "./links.js";
import { dayKey, hasTag, inFolder, parseDay } from "./query.js";

const TASK = /^([ \t]*)((?:>[ \t]?)*)([ \t]*)([-*+]|\d+[.)])[ \t]+\[(.)\](?:[ \t]+(.*))?$/;
const ITEM = /^([ \t]*)((?:>[ \t]?)*)([ \t]*)([-*+]|\d+[.)])[ \t]/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const DUE = /(?:📅|🗓️?)️?\s*(\d{4}-\d{2}-\d{2})|\[?\s*due::\s*(\d{4}-\d{2}-\d{2})\s*\]?/u;
const PRIORITIES = [
  { sign: "🔺", name: "highest", rank: 0 },
  { sign: "⏫", name: "high", rank: 1 },
  { sign: "🔼", name: "medium", rank: 2 },
  { sign: "🔽", name: "low", rank: 4 },
  { sign: "⏬", name: "lowest", rank: 5 },
];
export const PRIORITY_RANK = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };

const width = (s) => s.replace(/\t/g, "    ").length;

/** How many lines the properties block at the top takes (0 when there is none). */
function frontmatterLines(lines) {
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)\s*$/.test(lines[i])) return i + 1;
  return 0;
}

/** A task's text without its due date and priority signs, for showing. */
export function taskLabel(text) {
  let t = String(text ?? "").replace(DUE, " ");
  for (const p of PRIORITIES) t = t.split(p.sign).join(" ");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Every task of a page's Markdown, in order: `{line (0-based, in the whole Markdown), text (as written after the box),
 * label (without the date and priority), mark, done, cancelled, depth, indent, parent (the line of the task it is
 * nested under, or null), due ("YYYY-MM-DD" or null), priority (name or null), tags, heading (the section's heading or
 * null)}`.
 */
export function parseTasks(markdown) {
  const text = String(markdown ?? "");
  const lines = text.split("\n");
  const masked = maskCode(text).split("\n");
  const start = frontmatterLines(lines);
  const out = [];
  const stack = []; // open list items: {indent, task line or null}
  let heading = null;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    if (!masked[i].trim()) continue;
    const h = HEADING.exec(masked[i]);
    if (h) {
      heading = h[2].trim();
      stack.length = 0;
      continue;
    }
    const item = ITEM.exec(masked[i]);
    if (!item) {
      // A paragraph at the left edge ends the list; an indented one continues the item above it.
      if (!/^[ \t]/.test(masked[i]) && !/^>/.test(masked[i])) stack.length = 0;
      continue;
    }
    const indent = width(item[1]) + width(item[3]) + item[2].replace(/[ \t]/g, "").length * 2;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const m = TASK.exec(raw);
    const parent = [...stack].reverse().find((s) => s.task !== null)?.task ?? null;
    if (m) {
      const body = (m[6] ?? "").replace(/\s+$/, "");
      const mark = m[5];
      const due = DUE.exec(body);
      const prio = PRIORITIES.find((p) => body.includes(p.sign));
      out.push({
        line: i,
        text: body,
        label: taskLabel(body),
        mark,
        done: mark === "x" || mark === "X",
        cancelled: mark === "-",
        depth: stack.filter((s) => s.task !== null).length,
        indent,
        parent,
        due: due ? due[1] ?? due[2] : null,
        priority: prio?.name ?? null,
        tags: inlineTags(body),
        heading,
      });
      stack.push({ indent, task: i });
    } else {
      stack.push({ indent, task: null });
    }
  }
  return out;
}

/**
 * The Markdown with the task on `line` checked (done true), unchecked (false) or flipped (undefined). `text`: what the
 * task said when it was read; when that line no longer holds it (the page changed), the task with that text is used.
 * Throws when there is no such task.
 */
export function toggleTask(markdown, line, { done, text } = {}) {
  const md = String(markdown ?? "");
  const lines = md.split("\n");
  const tasks = parseTasks(md);
  let task = tasks.find((t) => t.line === line);
  if (text !== undefined && task?.text !== text) task = tasks.find((t) => t.text === text) ?? null;
  if (!task) throw new Error("That task isn't on the page any more (it was changed): open the page to check it off");
  const to = done === undefined ? !(task.done || task.cancelled) : Boolean(done);
  const raw = lines[task.line];
  const at = raw.search(/\[.\]/);
  lines[task.line] = `${raw.slice(0, at)}[${to ? "x" : " "}]${raw.slice(at + 3)}`;
  return lines.join("\n");
}

/** The Markdown with the task on `line` due on `date` ("YYYY-MM-DD"; null removes it), written `📅 date`. */
export function setTaskDue(markdown, line, date) {
  const lines = String(markdown ?? "").split("\n");
  const task = parseTasks(markdown).find((t) => t.line === line);
  if (!task) throw new Error("No task on that line");
  let raw = lines[line].replace(new RegExp(`\\s*${DUE.source}`, "u"), "");
  if (date) raw = `${raw.replace(/\s+$/, "")} 📅 ${date}`;
  lines[line] = raw;
  return lines.join("\n");
}

/** Where a due date falls from `today` ("YYYY-MM-DD"): overdue, today, tomorrow, week (the next 7 days), later, none. */
export function dueBucket(due, today = dayKey(Date.now())) {
  if (!due) return "none";
  const d = parseDay(due);
  const t = parseDay(today);
  if (d === null || t === null) return "none";
  const days = Math.round((d - t) / 86400000);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "week";
  return "later";
}
export const DUE_BUCKETS = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "week", label: "Next 7 days" },
  { id: "later", label: "Later" },
  { id: "none", label: "No date" },
];

/**
 * Every task across the wiki's live pages, as `{...task, page}`. `status`: open (default), done, or all; `folder`
 * (with its subfolders), `tag` (the page's or the task's), `page` (title or id), `due`: overdue, today, week (up to 7
 * days ahead, overdue included), none, any (has a date), or a date "YYYY-MM-DD" (due on or before it); `search`: words.
 */
export function allTasks(wiki, { status = "open", folder = null, tag = null, page = null, due = null, search = "",
  today = dayKey(Date.now()) } = {}) {
  const only = page ? wiki.find?.(page) ?? null : null;
  if (page && !only) return [];
  const pages = only ? [only] : wiki.live();
  const q = keyOf(search);
  const out = [];
  for (const p of pages) {
    if (folder && !inFolder(p, folder)) continue;
    if (!p.markdown.includes("[")) continue;
    for (const t of parseTasks(p.markdown)) {
      const closed = t.done || t.cancelled;
      if (status === "open" && closed) continue;
      if (status === "done" && !closed) continue;
      if (tag && !hasTag(p, tag) && !hasTag(t, tag)) continue;
      if (q && !keyOf(t.label).includes(q) && !keyOf(p.title).includes(q)) continue;
      if (due && !dueMatches(t.due, due, today)) continue;
      out.push({ ...t, page: p });
    }
  }
  return out;
}

function dueMatches(date, want, today) {
  const w = String(want).toLowerCase();
  if (w === "none") return !date;
  if (!date) return false;
  if (w === "any") return true;
  const b = dueBucket(date, today);
  if (w === "overdue") return b === "overdue";
  if (w === "today") return b === "today" || b === "overdue";
  if (w === "week") return b !== "later";
  if (parseDay(want) !== null) return date <= String(want).slice(0, 10);
  return true;
}

/** Sort tasks: by due date (none last), then priority, then page and line. */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) =>
    (a.due ? 0 : 1) - (b.due ? 0 : 1) || String(a.due ?? "").localeCompare(String(b.due ?? "")) ||
    PRIORITY_RANK[a.priority ?? "none"] - PRIORITY_RANK[b.priority ?? "none"] ||
    a.page.title.localeCompare(b.page.title) || a.line - b.line);
}

/** Tasks in groups: by `page`, `folder` or `due`. `[{key, label, tasks}]` in a useful order. */
export function groupTasks(tasks, by = "page", today = dayKey(Date.now())) {
  const groups = new Map();
  const put = (key, label, t) => {
    if (!groups.has(key)) groups.set(key, { key, label, tasks: [] });
    groups.get(key).tasks.push(t);
  };
  for (const t of tasks) {
    if (by === "due") {
      const b = dueBucket(t.due, today);
      put(b, DUE_BUCKETS.find((x) => x.id === b).label, t);
    } else if (by === "folder") put(keyOf(t.page.folder ?? ""), t.page.folder || "Top folder", t);
    else put(t.page.id, t.page.title, t);
  }
  const list = [...groups.values()];
  if (by === "due") list.sort((a, b) => DUE_BUCKETS.findIndex((x) => x.id === a.key) - DUE_BUCKETS.findIndex((x) => x.id === b.key));
  else list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  for (const g of list) g.tasks = by === "page" ? g.tasks.sort((a, b) => a.line - b.line) : sortTasks(g.tasks);
  return list;
}
