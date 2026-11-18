// The shell's own views: home (the start page), trash, a missing page, and a plain page view that the page part
// replaces (so the panel shows pages even without it).
import { add, el, icon } from "./dom.js";
import { keyOf } from "../../shared/links.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { bookmarks, markTitle, openMark } from "./data.js";
import { keyLabel } from "./pure.js";
import { tabIcon } from "./shell.js";
import { folders } from "./data.js";

const whoText = (by) => (by === "ai" ? "AI" : by === "you" || !by ? "you" : String(by).replace(/^plugin:/, ""));

/** Views other parts add, offered on the home page when they are there. */
const EXTRA_VIEWS = [
  { view: "graph", label: "Graph", icon: "waypoints", text: "How your pages link" },
  { view: "tasks", label: "Tasks", icon: "list-todo", text: "Every open checkbox" },
  { view: "calendar", label: "Calendar", icon: "calendar-days", text: "Daily notes by date" },
  { view: "ask", label: "Ask your wiki", icon: "sparkles", text: "Answers from your pages" },
  { view: "review", label: "Review", icon: "clipboard-check", text: "AI changes waiting for you" },
  { view: "attachments", label: "Attachments", icon: "paperclip", text: "Every file, where it is used" },
  { view: "health", label: "Health", icon: "activity", text: "Broken links, orphans" },
  { view: "types", label: "Page types", icon: "shapes", text: "Fields and templates" },
];

function pageIcon(app, p) {
  const t = p?.type ? app.wiki.type?.(p.type) : null;
  return tabIcon(t?.icon ?? "file-text");
}

function pageLink(app, p, extra = null) {
  return el("a", { class: "wiki-home-page", href: "#", "data-id": p.id, onclick: (e) => {
    e.preventDefault();
    app.openPage(p.id, { newTab: e.ctrlKey || e.metaKey });
  }, onauxclick: (e) => e.button === 1 && (e.preventDefault(), app.openPage(p.id, { newTab: true })) },
  pageIcon(app, p), el("span", { class: "wiki-home-page-title" }, p.title),
  p.folder ? el("span", { class: "wiki-home-page-folder" }, p.folder) : null, extra);
}

function card(title, iconName, ...children) {
  return el("section", { class: "wiki-card" },
    el("h2", { class: "wiki-card-title" }, icon(iconName), el("span", {}, title)), ...children);
}

function renderHome(root, _route, app) {
  const wiki = app.wiki;
  const live = wiki.live();
  const wrap = el("div", { class: "wiki-page-wrap wiki-home" });
  add(root, wrap);
  const hour = new Date().getHours();
  const hello = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const last = live.reduce((m, p) => Math.max(m, p.updated || 0), 0);
  const nFolders = folders(app).length;
  add(wrap, el("header", { class: "wiki-home-head" },
    el("h1", { class: "wiki-view-title" }, hello),
    el("p", { class: "wiki-home-stats" }, `${live.length} page${live.length === 1 ? "" : "s"}`,
      nFolders ? ` · ${nFolders} folder${nFolders === 1 ? "" : "s"}` : "",
      last ? ` · last edited ${app.ui.ago(last)}` : "")));

  // The search box only looks like one: it opens the quick switcher.
  add(wrap, el("button", { class: "wiki-home-search", onclick: () => app.commands.run("quick-switcher") },
    icon("search"), el("span", { class: "wiki-home-search-label" }, "Find or create a page…"),
    el("kbd", { class: "layr-kbd" }, keyLabel(app.commands.key("quick-switcher")) || "Ctrl+O")));

  // A key as the hint is hidden on the phone (no keyboard); a description stays.
  const action = (label, name, run, hint = "") => el("button", { class: "wiki-action", onclick: run,
    title: hint || label },
    icon(name), el("span", { class: "wiki-action-label" }, label),
    hint ? el("span", { class: `wiki-action-hint${/^(Ctrl|Alt|Shift|F\d)/.test(hint) ? " key" : ""}` }, hint) : null);
  const actions = [
    action("New page", "file-plus", () => app.newPage({ folder: app.defaultFolder() }),
      keyLabel(app.commands.key("new-page"))),
    typeof wiki.dailyNote === "function"
      ? action("Today's note", "calendar-check", () => app.commands.run("today").catch(app.ui.fail),
        keyLabel(app.commands.key("today"))) : null,
    action("Search", "text-search", () => app.commands.run("search"), keyLabel(app.commands.key("search"))),
    action("Commands", "terminal", () => app.commands.run("command-palette"),
      keyLabel(app.commands.key("command-palette"))),
    ...EXTRA_VIEWS.filter((v) => app.views.get(v.view)).map((v) => action(v.label, v.icon, (e) =>
      app.open({ view: v.view }, { newTab: e?.ctrlKey || e?.metaKey }), v.text)),
  ].filter(Boolean);
  add(wrap, el("div", { class: "wiki-actions" }, ...actions));

  if (!live.length) {
    add(wrap, el("div", { class: "wiki-welcome" },
      icon("book-open", "big"),
      el("h2", {}, "Welcome to your wiki"),
      el("p", {},
        "One page per thing you want to remember: a topic, a project, a person, a book, an idea. Link pages " +
        "with [[double brackets]], sort them into folders, tag them with #tags. The AI can read and write them too."),
      el("div", { class: "wiki-row center" },
        el("button", { class: "layr-button primary", onclick: () => app.newPage({ title: "Home", folder: "" }) },
          "Start with a Home page"),
        el("button", { class: "layr-button", onclick: () => app.commands.run("import-folder") },
          "Import a folder…"))));
    return;
  }

  const grid = el("div", { class: "wiki-home-grid" });
  add(wrap, grid);
  const homePage = wiki.resolve("Home");
  const recent = wiki.recent(homePage ? 11 : 12).filter((p) => p !== homePage);
  add(grid, card("Recently edited", "history",
    homePage ? pageLink(app, homePage, el("span", { class: "layr-badge accent" }, "Home")) : null,
    el("div", { class: "wiki-home-list" }, ...recent.map((p) => pageLink(app, p,
      el("span", { class: "wiki-home-when", title: new Date(p.updated).toLocaleString() },
        `${app.ui.ago(p.updated)}${p.by && p.by !== "you" ? ` · ${whoText(p.by)}` : ""}`))))));

  const marks = bookmarks();
  add(grid, card("Bookmarks", "bookmark", marks.length
    ? el("div", { class: "wiki-home-list" }, ...marks.slice(0, 12).map((m) => el("a", { class: "wiki-home-page",
      href: "#",
      onclick: (e) => (e.preventDefault(), openMark(app, m, { newTab: e.ctrlKey || e.metaKey })) },
    tabIcon(m.kind === "page" ? "file-text" : { search: "search", tag: "hash",
      folder: "folder" }[m.kind] ?? "layout-grid"),
    el("span", { class: "wiki-home-page-title" }, markTitle(app, m)))))
    : el("p", { class: "layr-muted" }, "Pin pages, folders, searches and views here: Bookmark in their menu.")));

  const wanted = wiki.wanted();
  if (wanted.length) {
    add(grid, card(`Wanted pages`, "file-question-mark",
      el("p", { class: "layr-muted" }, "Linked from somewhere, not written yet."),
      el("div", { class: "wiki-chips" }, ...wanted.slice(0, 24).map((w) => el("a", { class: "wiki-chip missing",
        href: "#",
        "data-page": w.title, title: `Linked from ${w.from.map((p) => p.title).join(", ")}` }, w.title,
      w.from.length > 1 ? el("span", { class: "wiki-chip-n" }, String(w.from.length)) : null)))));
  }

  const tagCounts = new Map();
  for (const p of live) for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  if (tagCounts.size) {
    add(grid, card("Tags", "tags", el("div", { class: "wiki-chips" },
      ...[...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => el("a", { class: "wiki-chip tag",
        href: "#",
        "data-tag": t }, `#${t}`, el("span", { class: "wiki-chip-n" }, String(n)))))));
  }
}

function renderTrash(root, _route, app) {
  const wrap = el("div", { class: "wiki-page-wrap" });
  add(root, wrap);
  const pages = app.wiki.trashed();
  add(wrap, el("header", { class: "wiki-view-head" }, el("h1", { class: "wiki-view-title" }, "Trash"),
    el("span", { class: "wiki-bar-fill" }),
    pages.length ? el("button", { class: "layr-button danger small", onclick: async () => {
      if (!(await app.ui.confirm(`Delete all ${pages.length} pages in the trash forever?`, { danger: true,
        ok: "Delete forever",
          detail: "They and their history will be gone on every device. This can't be undone." }))) return;
      for (const p of pages) await app.wiki.destroy(p.id).catch(app.ui.fail);
      app.refresh();
    } }, icon("trash-2"), " Empty the trash") : null));
  if (!pages.length) {
    add(wrap, el("div", { class: "wiki-empty" }, icon("trash-2", "big"), el("p", {}, "Nothing in the trash."),
      el("p", { class: "layr-muted" }, "Pages you delete wait here, so you can restore them.")));
    return;
  }
  add(wrap, el("p", { class: "layr-muted" }, "Pages here keep their history. Restore puts a page back where it was."));
  add(wrap, el("div", { class: "wiki-list" }, ...pages.map((p) => el("div", { class: "wiki-list-row" },
    pageIcon(app, p),
    el("div", { class: "wiki-list-main" }, el("span", { class: "wiki-list-title" }, p.title),
      el("span", { class: "wiki-list-detail" },
        `${p.folder ? `${p.folder} · ` : ""}deleted ${app.ui.ago(p.trashed)}`)),
    el("button", { class: "layr-button small", onclick: async () => {
      try {
        const back = await app.wiki.untrash(p.id, { by: "you" });
        app.ui.notify(`“${p.title}” is back`, "success");
        if (back?.id) app.openPage(back.id);
      } catch (error) {
        app.ui.fail(error);
      }
    } }, icon("rotate-ccw"), " Restore"),
    el("button", { class: "layr-button ghost small danger-text", onclick: async () => {
      if (!(await app.ui.confirm(`Delete “${p.title}” forever?`, { danger: true, ok: "Delete forever",
        detail: "It and all its history will be gone on every device. This can't be undone." }))) return;
      await app.wiki.destroy(p.id).catch(app.ui.fail);
      app.refresh();
    } }, "Delete forever")))));
}

function renderMissing(root, route, app) {
  const title = route.title ?? "";
  const from = app.wiki.wanted().find((w) => keyOf(w.title) === keyOf(title))?.from ?? [];
  const wrap = el("div", { class: "wiki-page-wrap wiki-missing" },
    el("h1", { class: "wiki-view-title missing-title" }, title),
    el("p", {}, "There is no page with this title yet."),
    el("div", { class: "wiki-row" },
      el("button", { class: "layr-button primary", onclick: () => app.newPage({ title, folder: app.defaultFolder() }) },
        icon("file-plus"), " Create it")),
    from.length ? el("div", { class: "wiki-missing-from" }, el("h3", {}, "Linked from"),
      el("div", { class: "wiki-home-list" }, ...from.map((p) => pageLink(app, p)))) : null);
  add(root, wrap);
}

/** A plain reading view: the page part replaces it with the real one. */
function renderPlainPage(root, route, app) {
  const page = app.wiki.pages.get(route.id);
  if (!page || page.trashed) {
    add(root, el("div", { class: "wiki-empty" }, icon("file-x", "big"),
      el("h2", {}, page ? "This page is in the trash" : "This page is gone"),
      el("button", { class: "layr-button", onclick: () => app.open({ view: page ? "trash" : "home" },
        { replace: true }) },
        page ? "Open the trash" : "Go home")));
    return;
  }
  const resolve = (t) => {
    const p = app.wiki.resolve(t);
    return p ? { title: p.title, exists: true } : { title: t, exists: false };
  };
  add(root, el("article", { class: "wiki-page-wrap" },
    el("h1", { class: "wiki-view-title page-title" }, page.title),
    el("div", { class: "md", html: renderMarkdown(page.body, { resolve }) })));
}

export function registerViews(app) {
  app.views.register("home", { title: "Home", icon: "house", render: renderHome });
  app.views.register("trash", { title: "Trash", icon: "trash-2", render: renderTrash });
  app.views.register("missing", { title: (r) => r.title ?? "New page", icon: "file-plus", render: renderMissing });
  app.views.register("page", { title: (r) => app.wiki.pages.get(r.id)?.title ?? "Page", icon: "file-text",
    render: renderPlainPage });
}
