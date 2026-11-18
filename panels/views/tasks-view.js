// The Tasks view (route `tasks` {status?, group?, folder?, q?}): every checklist item across the pages, grouped by
// page, folder or due date; checking one off rewrites just that line of its page.
import { escapeHtml } from "../app/dom.js";
import { dayKey } from "../../shared/query.js";
import { allTasks, dueBucket, groupTasks, toggleTask } from "../../shared/tasks.js";
import { allFolders, button, el, fail, icon, pageLink, typeIcon, watch } from "./common.js";

const PRIORITY_ICON = { highest: "chevrons-up", high: "chevron-up", medium: "minus", low: "chevron-down", lowest: "chevrons-down" };

/** A task's text with its [[links]] as links and #tags as tags (the rest as plain text). */
function taskHtml(text) {
  return escapeHtml(text)
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, t, label) =>
      `<a class="wl" href="#" data-page="${t.trim()}">${(label ?? t).trim()}</a>`)
    .replace(/(^|\s)#([\p{L}_][\p{L}\p{N}_\-/]*)/gu, '$1<span class="vw-tag">#$2</span>')
    .replace(/==([^=]+)==/g, "<mark>$1</mark>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function renderTasks(root, route, app) {
  const state = { status: route.status ?? "open", group: route.group ?? "due", folder: route.folder ?? "", q: route.q ?? "" };
  const remember = () => app.updateRoute?.({ status: state.status, group: state.group, folder: state.folder || null,
    q: state.q || null });
  const wrap = el("div", { class: "vw-page vw-tasks" });
  root.append(wrap);

  const toggle = async (t, done) => {
    const page = app.wiki.pages.get(t.page.id);
    try {
      if (!page) throw new Error("That page is gone");
      await app.wiki.save(page.id, toggleTask(page.markdown, t.line, { done, text: t.text }));
    } catch (error) {
      fail(app, error);
      draw();
    }
  };

  const row = (t, showPage) => {
    const today = dayKey(Date.now());
    const bucket = dueBucket(t.due, today);
    const box = el("input", { type: "checkbox", class: "vw-check", checked: t.done || t.cancelled,
      "aria-label": t.done ? "Mark as not done" : "Mark as done", onchange: (e) => toggle(t, e.target.checked) });
    return el("li", { class: `vw-task ${t.done ? "done" : ""} ${t.cancelled ? "cancelled" : ""}`,
      style: { "--depth": String(t.depth) } },
    box,
    el("span", { class: "vw-task-text", html: taskHtml(t.label || "(empty)") }),
    el("span", { class: "vw-task-meta" },
      t.priority ? el("span", { class: `vw-prio p-${t.priority}`, title: `${t.priority} priority` }, icon(PRIORITY_ICON[t.priority])) : null,
      t.due ? el("span", { class: `vw-due ${bucket}`, title: `Due ${t.due}` }, icon("calendar"), dueText(t.due, bucket)) : null,
      showPage ? el("span", { class: "vw-task-page" }, typeIcon(app.wiki, t.page.type), pageLink(t.page)) : null,
      button("arrow-up-right", "", (e) => app.openPage(t.page.id, { heading: t.heading ?? null, line: t.line,
        newTab: e.ctrlKey || e.metaKey }), { title: "Open the page at this task", cls: "vw-task-go" })));
  };

  const dueText = (due, bucket) => {
    if (bucket === "today") return "Today";
    if (bucket === "tomorrow") return "Tomorrow";
    const d = new Date(`${due}T00:00`);
    if (Number.isNaN(d.getTime())) return due;
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  };

  const draw = () => {
    const wiki = app.wiki;
    const tasks = allTasks(wiki, { status: state.status, folder: state.folder || null, search: state.q });
    const open = state.status === "open" ? tasks : allTasks(wiki, { status: "open" });
    const overdue = open.filter((t) => dueBucket(t.due) === "overdue").length;
    const seg = (key, options) => el("div", { class: "vw-seg small" }, options.map(([v, label]) =>
      el("button", { type: "button", class: state[key] === v ? "active" : "", onclick: () => { state[key] = v; remember(); draw(); } }, label)));
    const search = el("input", { class: "layr-input vw-grow", type: "search", placeholder: "Search tasks", value: state.q,
      oninput: (e) => {
        state.q = e.target.value;
        remember();
        drawList();
      } });
    const folders = allFolders(wiki);
    const head = el("header", { class: "vw-head" },
      el("h1", { class: "vw-title" }, icon("square-check-big"), "Tasks"),
      el("span", { class: "layr-muted" }, `${open.length} open${overdue ? ` · ` : ""}`,
        overdue ? el("span", { class: "vw-overdue-count" }, `${overdue} overdue`) : null));
    const bar = el("div", { class: "vw-bar" },
      seg("status", [["open", "Open"], ["done", "Done"], ["all", "All"]]),
      el("span", { class: "vw-bar-label layr-muted" }, "Group by"),
      seg("group", [["due", "Due"], ["page", "Page"], ["folder", "Folder"]]),
      folders.length ? el("select", { class: "layr-select vw-folder-sel", onchange: (e) => { state.folder = e.target.value; remember(); draw(); } },
        el("option", { value: "" }, "All folders"), folders.map((f) => el("option", { value: f, selected: f === state.folder }, f))) : null,
      search);
    const list = el("div", { class: "vw-task-groups" });
    const drawList = () => {
      const items = allTasks(app.wiki, { status: state.status, folder: state.folder || null, search: state.q });
      list.replaceChildren();
      if (!items.length) {
        list.append(el("div", { class: "layr-empty vw-empty" }, icon("square-check-big", "big"),
          el("p", {}, state.q ? `No task holds “${state.q}”.` : state.status === "open" ? "Nothing to do: no open tasks."
            : state.status === "done" ? "No finished tasks yet." : "No tasks yet."),
          el("p", { class: "layr-muted" }, "Write “- [ ] something” on any page; a due date as 📅 2026-11-20.")));
        return;
      }
      for (const g of groupTasks(items, state.group)) {
        const first = g.tasks[0].page;
        const title = state.group === "page"
          ? el("span", { class: "vw-group-title" }, typeIcon(app.wiki, first.type), pageLink(first),
            first.folder ? el("span", { class: "layr-muted vw-group-folder" }, first.folder) : null)
          : el("span", { class: `vw-group-title ${g.key === "overdue" ? "vw-overdue-count" : ""}` },
            state.group === "folder" ? icon("folder") : null, g.label);
        list.append(el("section", { class: "vw-task-group" },
          el("h2", {}, title, el("span", { class: "vw-count" }, String(g.tasks.length))),
          el("ul", { class: "vw-task-list" }, g.tasks.map((t) => row(t, state.group !== "page")))));
      }
    };
    drawList();
    wrap.replaceChildren(head, bar, list);
  };
  draw();
  return watch(app, root, draw);
}
