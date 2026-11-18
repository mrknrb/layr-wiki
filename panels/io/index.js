// Part E, in and out: export (HTML, Markdown, Word), print, import (Word, Notion) and public links. Page ⋯ menu
// entries, commands, and the right sidebar's "Public" panel for a published page.
import { exportPages, openExportDialog, pagesInFolder, printPages } from "./export.js";
import { importNotion, importWord } from "./import.js";
import { loadShares, publish, renderSharePanel, shareMenu, shareOf } from "./share.js";

function loadCss(href) {
  if ([...document.querySelectorAll("link[rel=stylesheet]")].some((l) => l.href === href)) return;
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));
}

export function install(app) {
  loadCss(new URL("./io.css", import.meta.url).href);
  loadShares().then(() => {
    app.emit?.("shares", {});
    app.emit?.("layout", { sidebar: "right" });
  });
  const page = () => app.page?.() ?? null;
  const onPage = () => Boolean(page());

  app.pageMenu?.register((p) => [
    // Menu icons are Material names (layr draws the menu).
    { label: "Export", icon: "download", items: [
      { label: "HTML (one file)", icon: "code", run: () => exportPages(app, [p], "html") },
      { label: "Markdown", icon: "description", run: () => exportPages(app, [p], "markdown") },
      { label: "Word (.docx)", icon: "article", run: () => exportPages(app, [p], "docx") },
      "-",
      { label: "Several pages…", icon: "library_books", run: () => openExportDialog(app, { page: p }) },
    ] },
    { label: "Print or save as PDF…", icon: "print", run: () => printPages(app, [p]) },
    ...shareMenu(app, p),
  ]);

  // A folder's export, for the file tree's folder menu (C1) when it offers one.
  app.exportFolder = (folder, format = "html") => exportPages(app, pagesInFolder(app.wiki, folder), format,
    { title: folder ? folder.split("/").pop() : "Wiki" });

  const commands = [
    { id: "export", title: "Export pages…", icon: "download", run: () => openExportDialog(app) },
    { id: "export-page-html", title: "Export this page as HTML", icon: "file-code", when: onPage,
      run: () => exportPages(app, [page()], "html") },
    { id: "export-page-docx", title: "Export this page as Word", icon: "file-type", when: onPage,
      run: () => exportPages(app, [page()], "docx") },
    { id: "print", title: "Print this page", icon: "printer", when: onPage,
      run: () => printPages(app, [page()]) },
    { id: "import-word", title: "Import a Word file", icon: "file-up", run: () => importWord(app) },
    { id: "import-notion", title: "Import a Notion export", icon: "file-archive", run: () => importNotion(app) },
    { id: "publish", title: "Publish this page to the web", icon: "globe", when: onPage,
      run: () => publish(app, page()).catch((e) => app.ui.fail(e)) },
  ];
  for (const c of commands) app.commands?.register(c);

  app.sidebar?.register("right", { id: "share", title: "Public", icon: "globe", order: 70,
    when: () => Boolean(page() && shareOf(page().id)), render: (root) => renderSharePanel(app, root) });
  // A badge by the page's title, when the page part offers the hook.
  app.pageBadges?.register?.((p) => (shareOf(p.id)
    ? [{ text: "Public", icon: "globe", title: "Anyone with the link can read this page", run: () =>
      navigator.clipboard.writeText(shareOf(p.id).url).then(() => app.ui.notify("Public link copied", "success")) }]
    : []));
}
