// Part D of the panel: the views over many pages. Database views (`view`), the graph (`graph` and the local graph in
// the right sidebar), tasks, attachments, health, the type editor (`types`), the calendar (left sidebar and
// `calendar`), the saved views in the left sidebar, and their commands. `install(app)` registers them (PLAN.md).
import { renderAttachments } from "./attachments.js";
import { calendarPanel, openDaily, renderCalendar } from "./calendar.js";
import { button, el, icon, SavedViews } from "./common.js";
import { bookmark, newView, renderDatabase } from "./database.js";
import { localGraphPanel, renderGraph } from "./graph.js";
import { renderHealth } from "./health.js";
import { renderTasks } from "./tasks-view.js";
import { renderTypes } from "./types.js";

export function install(app) {
  const saved = new SavedViews(app);
  app.savedViews = saved;
  saved.load();
  // For the shell (a folder's or a tag's menu, the type editor): a view of these pages, opened. PLAN.md › Views.
  app.views.createFor = (source, opts) => saved.createFor(source ?? {}, opts);
  app.views.saved = () => [...saved.list];
  app.on("changed", (d) => {
    if (d?.views) saved.load();
  });

  // ---------- views (tab contents) ----------

  app.views.register("view", {
    title: (route) => saved.get(route.id)?.name ?? "View",
    icon: (route) => saved.get(route.id)?.icon ?? "table",
    render: (root, route) => renderDatabase(root, route, app),
    redraw: false,
  });
  app.views.register("graph", {
    title: (route) => (route.id && app.wiki.pages.get(route.id) ? `Graph: ${app.wiki.pages.get(route.id).title}` : "Graph"),
    icon: "graph",
    render: (root, route) => renderGraph(root, route, app),
    redraw: false,
  });
  app.views.register("tasks", { title: "Tasks", icon: "square-check-big", render: (root, route) => renderTasks(root, route, app),
    redraw: false });
  app.views.register("attachments", { title: "Attachments", icon: "paperclip",
    render: (root, route) => renderAttachments(root, route, app), redraw: false });
  app.views.register("health", { title: "Wiki health", icon: "health", render: (root, route) => renderHealth(root, route, app),
    redraw: false });
  app.views.register("types", { title: (route) => (route.name ? `Type: ${route.name}` : "Page types"), icon: "shapes",
    render: (root, route) => renderTypes(root, route, app), redraw: false });
  app.views.register("calendar", { title: "Calendar", icon: "calendar-days", render: (root, route) => renderCalendar(root, route, app),
    redraw: false });

  // ---------- sidebars ----------

  app.sidebar.register("left", viewsPanel(app));
  app.sidebar.register("left", calendarPanel(app));
  app.sidebar.register("right", localGraphPanel(app));

  // ---------- commands ----------

  const cmd = (spec) => app.commands.register(spec);
  cmd({ id: "open-graph", title: "Open the graph view", icon: "graph", key: "ctrl+g", run: () => app.open({ view: "graph" }) });
  cmd({ id: "open-page-graph", title: "Open the graph around this page", icon: "graph", when: () => Boolean(app.page()),
    run: () => app.open({ view: "graph", id: app.page().id }) });
  cmd({ id: "show-local-graph", title: "Show the local graph", icon: "graph", run: () => app.sidebar.show?.("right", "local-graph") });
  cmd({ id: "open-tasks", title: "Open tasks", icon: "square-check-big", key: "ctrl+shift+k", run: () => app.open({ view: "tasks" }) });
  cmd({ id: "open-attachments", title: "Attachments", icon: "paperclip", run: () => app.open({ view: "attachments" }) });
  cmd({ id: "open-health", title: "Wiki health (broken links, orphans, duplicates)", icon: "health",
    run: () => app.open({ view: "health" }) });
  cmd({ id: "open-types", title: "Page types", icon: "shapes", run: () => app.open({ view: "types" }) });
  cmd({ id: "edit-page-type", title: "Edit this page's type", icon: "shapes", when: () => Boolean(app.page()?.type),
    run: () => app.open({ view: "types", name: app.page().type }) });
  cmd({ id: "new-view", title: "New database view", icon: "table", run: () => newView(app) });
  cmd({ id: "type-table", title: "Open all pages of this type as a table", icon: "table", when: () => Boolean(app.page()?.type),
    run: () => saved.createFor({ type: app.page().type }) });
  cmd({ id: "folder-table", title: "Open this folder as a table", icon: "table", when: () => Boolean(app.page()?.folder),
    run: () => saved.createFor({ folder: app.page().folder }) });
  cmd({ id: "open-calendar", title: "Open the calendar", icon: "calendar-days", run: () => app.open({ view: "calendar" }) });
  cmd({ id: "show-calendar", title: "Show the calendar", icon: "calendar-days", run: () => app.sidebar.show?.("left", "calendar") });
  cmd({ id: "show-views", title: "Show the saved views", icon: "table", run: () => app.sidebar.show?.("left", "views") });
  // "Open today's note" is the shell's (`today`); without it, it is here.
  if (!app.commands.get?.("today")) {
    cmd({ id: "today", title: "Open today's note", icon: "calendar-check", key: "ctrl+alt+d", run: () => openDaily(app) });
  }
  const shift = (days) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  };
  cmd({ id: "yesterday", title: "Open yesterday's note", icon: "calendar-minus", run: () => openDaily(app, shift(-1)) });
  cmd({ id: "tomorrow", title: "Open tomorrow's note", icon: "calendar-plus", run: () => openDaily(app, shift(1)) });

  // The page's ⋯ menu: its neighbourhood and its type.
  app.pageMenu?.register?.((page) => [
    { label: "Open in the graph", icon: "hub", run: () => app.open({ view: "graph", id: page.id }) },
    ...(page.type ? [{ label: `All ${page.type} pages as a table`, icon: "table_chart", run: () => saved.createFor({ type: page.type }) },
      { label: `Edit the type ${page.type}`, icon: "category", run: () => app.open({ view: "types", name: page.type }) }] : []),
  ]);
}

/** The left sidebar's list of saved views. */
function viewsPanel(app) {
  const saved = app.savedViews;
  let off = null;
  const fill = (list) => {
    const route = app.route();
    list.replaceChildren();
    if (!saved.list.length) {
      list.append(el("div", { class: "vw-side-empty" }, el("p", { class: "layr-muted" }, "No saved views yet. A view shows a set of " +
        "pages as a table, board, gallery, calendar or list."), button("plus", "New view", () => newView(app))));
      return;
    }
    for (const v of saved.list) {
      const active = route.view === "view" && route.id === v.id;
      const row = el("div", { class: `wiki-tree-row vw-side-row ${active ? "active" : ""}`, role: "listitem", tabindex: "0",
        title: v.name, onclick: (e) => app.open({ view: "view", id: v.id }, { newTab: e.ctrlKey || e.metaKey }),
        onauxclick: (e) => e.button === 1 && app.open({ view: "view", id: v.id }, { newTab: true }),
        onkeydown: (e) => e.key === "Enter" && app.open({ view: "view", id: v.id }),
        oncontextmenu: (e) => {
          e.preventDefault();
          app.ui.menu([
            { label: "Open in a new tab", icon: "open_in_new", run: () => app.open({ view: "view", id: v.id }, { newTab: true }) },
            { label: "Rename…", icon: "edit", run: async () => {
              const n = await app.ui.prompt("Rename the view", { value: v.name, ok: "Rename" });
              if (n?.trim()) await saved.save({ ...v, name: n.trim() });
            } },
            { label: "Duplicate", icon: "content_copy", run: () => saved.save({ ...v, id: undefined, name: `${v.name} (copy)` }) },
            ...(app.wiki.setBookmarks ? [{ label: "Bookmark", icon: "bookmark", run: () => bookmark(app, v) }] : []),
            "-",
            { label: "Delete view", icon: "delete", danger: true, run: async () => {
              if (await app.ui.confirm(`Delete the view "${v.name}"? Its pages stay.`, { danger: true, ok: "Delete" })) {
                await saved.remove(v.id);
                if (app.route().view === "view" && app.route().id === v.id) app.open({ view: "home" }, { replace: true });
              }
            } },
          ], e).catch?.(() => {});
        } },
      icon(v.icon || "table"), el("span", { class: "vw-side-name" }, v.name),
      el("span", { class: "layr-muted vw-side-kind" }, v.layout));
      list.append(row);
    }
  };
  return {
    id: "views",
    title: "Views",
    icon: "table",
    order: 45,
    render(root) {
      const list = el("div", { class: "wiki-tree vw-side-list", role: "list", "aria-label": "Saved views" });
      root.append(el("div", { class: "wiki-side-head" }, el("span", { class: "wiki-side-title" }, "Views"),
        el("span", { class: "wiki-bar-fill" }),
        el("button", { class: "layr-button ghost icon small", title: "New database view", "aria-label": "New database view",
          onclick: () => newView(app) }, icon("plus"))), list,
      links());
      fill(list);
      saved.ready().then(() => list.isConnected && fill(list));
      off = saved.on(() => list.isConnected && fill(list));
      return () => off?.();
    },
    update(root) {
      const list = root.querySelector(".vw-side-list");
      if (list) fill(list);
      root.querySelector(".vw-side-links")?.replaceWith(links());
    },
  };
  function links() {
    return el("div", { class: "vw-side-links" },
      sideLink("square-check-big", "Tasks", { view: "tasks" }), sideLink("graph", "Graph", { view: "graph" }),
      sideLink("shapes", "Types", { view: "types" }), sideLink("paperclip", "Attachments", { view: "attachments" }),
      sideLink("health", "Health", { view: "health" }));
  }
  function sideLink(ic, label, route) {
    const active = app.route().view === route.view;
    return el("button", { type: "button", class: `vw-side-link ${active ? "active" : ""}`,
      onclick: (e) => app.open(route, { newTab: e.ctrlKey || e.metaKey }) }, icon(ic), el("span", {}, label));
  }
}
