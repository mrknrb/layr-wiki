// Part C2, the page (docs/PLAN.md): the page and missing-page views, the right sidebar's page panels, and what the
// other parts call: app.markdown (draw Markdown), app.hoverPreview (a page's preview by a link), app.newPage (the New
// page dialog). app.editor is set by the page view while a page is being edited.
import { hoverPreview } from "./hover.js";
import { newPageDialog } from "./newpage.js";
import { openAttachment, renderEmbed, renderInto, viewImage } from "./render.js";
import { installSidebar } from "./sidebar.js";
import { active, loadCss, loadHighlighter, safe } from "./util.js";
import { PageView, renderMissing } from "./view.js";

export function install(app) {
  loadCss();
  // The highlighter loads in the background, so code in the first page shown is coloured as soon as it can be.
  setTimeout(() => loadHighlighter(), 0);

  app.markdown = (root, markdown, opts = {}) => renderInto(app, root, markdown, opts);
  app.hoverPreview = (anchor, title, opts = {}) => hoverPreview(app, anchor, title, opts);
  app.newPage = (opts = {}) => newPageDialog(app, opts);
  // Part A's editor calls these when they exist (double-click a picture, a file card's Open, a PDF card's view).
  app.viewImage = (name) => viewImage(app, name);
  app.openAttachment = (name) => openAttachment(app, name);
  app.renderEmbed = (host, target) => renderEmbed(app, host, target);

  // Badges by a page's title, from other parts: `register((page) => [{text, icon, title, run}])`.
  if (!app.pageBadges?.items) {
    const fns = new Set();
    app.pageBadges = {
      register(fn) {
        fns.add(fn);
        return () => fns.delete(fn);
      },
      items: (page) => [...fns].flatMap((fn) => safe(() => fn(page, app), []) ?? []).filter(Boolean),
    };
  }

  app.views.register("page", {
    title: (route) => app.wiki.pages.get(route.id)?.title ?? "Missing page",
    icon: (route) => {
      const page = app.wiki.pages.get(route.id);
      return (page?.type && safe(() => app.wiki.type(page.type))?.icon) || "file-text";
    },
    // The view follows changes itself (it may be in the middle of typing).
    redraw: false,
    render(root, route) {
      const view = new PageView(app, root, route);
      return () => view.destroy();
    },
  });
  app.views.register("missing", {
    title: (route) => route.title ?? "New page",
    icon: "file-plus",
    render: (root, route) => renderMissing(app, root, route),
  });

  installSidebar(app);

  const onPage = () => app.route().view === "page" && Boolean(active.view);
  const cmd = (spec) => safe(() => app.commands.register(spec));
  cmd({ id: "toggle-edit", title: "Switch between reading and editing", icon: "pencil", key: "ctrl+e", when: onPage,
    run: () => active.view?.setMode(active.view.mode === "edit" ? "read" : "edit") });
  cmd({ id: "save-page", title: "Save the page now", icon: "save", key: "ctrl+s", when: onPage,
    run: () => active.view?.flush() });
  cmd({ id: "page-history", title: "History of this page", icon: "history", when: onPage,
    run: () => active.view?.history() });
  cmd({ id: "rename-title", title: "Rename this page (edit its title)", icon: "pencil", when: onPage,
    run: () => active.view?.startRename() });
  cmd({ id: "show-outline", title: "Show the outline", icon: "list-tree",
    run: () => app.sidebar.show?.("right", "outline") });
  cmd({ id: "show-backlinks", title: "Show the backlinks", icon: "link",
    run: () => app.sidebar.show?.("right", "backlinks") });
  cmd({ id: "show-unlinked", title: "Show unlinked mentions", icon: "unlink",
    run: () => app.sidebar.show?.("right", "unlinked") });
}
