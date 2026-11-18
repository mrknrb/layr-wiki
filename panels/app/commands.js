// The shell's own commands: in the palette, on their keys (users rebind them in Settings › Keyboard shortcuts).
import { add } from "./dom.js";
import { keyOf, titleProblem } from "../../shared/links.js";
import { commandPalette, pickFolder, quickSwitcher } from "./switcher.js";
import { createFolder, markFor, movePage, toggleBookmark } from "./data.js";
import { quickNoteTitle } from "./pure.js";

const pageUrl = (title) => `layr://wiki/page/${encodeURIComponent(title)}`;

export function registerCommands(app) {
  const hasPage = () => Boolean(app.page());
  const cmd = (spec) => app.commands.register(spec);

  cmd({ id: "quick-switcher", title: "Open a page (quick switcher)", icon: "search", key: "ctrl+o",
    run: quickSwitcher });
  cmd({ id: "command-palette", title: "Command palette", icon: "terminal", key: "ctrl+p", run: commandPalette });
  cmd({ id: "new-page", title: "New page", icon: "file-plus", key: "ctrl+n",
    run: () => app.newPage({ folder: app.defaultFolder() }) });
  cmd({ id: "new-folder", title: "New folder", icon: "folder-plus", run: () => newFolder(app, app.defaultFolder()) });
  cmd({ id: "quick-note", title: "Quick note", icon: "notebook-pen", run: () => quickNote(app) });
  cmd({ id: "today", title: "Open today's note", icon: "calendar-check", key: "ctrl+shift+d",
    when: () => typeof app.wiki.dailyNote === "function", run: () => openToday(app) });
  cmd({ id: "search", title: "Search all pages", icon: "search", key: "ctrl+shift+s", run: () => {
    app.sidebar.show("left", "search");
    setTimeout(() => document.querySelector("#searchInput")?.select(), 30);
  } });
  cmd({ id: "show-files", title: "Show the files", icon: "folder-tree", run: () => app.sidebar.show("left", "files") });
  cmd({ id: "show-tags", title: "Show the tags", icon: "tags", run: () => app.sidebar.show("left", "tags") });
  cmd({ id: "show-bookmarks", title: "Show the bookmarks", icon: "bookmark",
    run: () => app.sidebar.show("left", "bookmarks") });
  cmd({ id: "home", title: "Go home", icon: "house", run: () => app.open({ view: "home" }) });
  cmd({ id: "trash", title: "Open the trash", icon: "trash-2", run: () => app.open({ view: "trash" }) });
  cmd({ id: "settings", title: "Wiki settings", icon: "settings", run: () => app.open({ view: "settings" }) });
  cmd({ id: "hotkeys", title: "Keyboard shortcuts", icon: "keyboard",
    run: () => app.open({ view: "settings", group: "hotkeys" }) });

  // Tabs and moving around.
  cmd({ id: "new-tab", title: "New tab", icon: "plus", key: "ctrl+t", run: () => app.open({ view: "home" },
    { newTab: true }) });
  cmd({ id: "close-tab", title: "Close tab", icon: "x", key: "ctrl+w", when: () => app.tabs.list().length > 1,
    run: () => app.tabs.close() });
  cmd({ id: "close-other-tabs", title: "Close the other tabs", icon: "x", when: () => app.tabs.list().length > 1,
    run: () => app.tabs.closeOthers() });
  cmd({ id: "reopen-tab", title: "Reopen the closed tab", icon: "rotate-ccw", key: "ctrl+shift+t",
    run: () => app.tabs.reopen() });
  cmd({ id: "next-tab", title: "Next tab", icon: "chevron-right", key: "ctrl+tab",
    when: () => app.tabs.list().length > 1,
    run: () => app.tabs.step(1) });
  cmd({ id: "prev-tab", title: "Previous tab", icon: "chevron-left", key: "ctrl+shift+tab",
    when: () => app.tabs.list().length > 1, run: () => app.tabs.step(-1) });
  for (let n = 1; n <= 9; n++) {
    cmd({ id: `tab-${n}`, title: `Go to tab ${n}`, hidden: true, key: `alt+${n}`,
      when: () => n === 9 || app.tabs.list().length >= n,
        run: () => app.tabs.activate(n === 9 ? app.tabs.list().length - 1 : n - 1) });
  }
  cmd({ id: "back", title: "Back", icon: "arrow-left", key: "alt+arrowleft", run: () => app.back() });
  cmd({ id: "forward", title: "Forward", icon: "arrow-right", key: "alt+arrowright", run: () => app.forward() });

  // Layout.
  cmd({ id: "toggle-left", title: "Show or hide the left sidebar", icon: "panel-left", key: "ctrl+\\",
    run: () => app.sidebar.toggle("left") });
  cmd({ id: "toggle-right", title: "Show or hide the right sidebar", icon: "panel-right", key: "ctrl+shift+\\",
    run: () => app.sidebar.toggle("right") });
  cmd({ id: "focus-mode", title: "Focus mode", icon: "maximize-2", key: "ctrl+shift+f",
    run: () => app.setFocus(!app.isFocus()) });

  // The open page.
  cmd({ id: "rename-page", title: "Rename this page", icon: "pencil", key: "f2", when: hasPage,
    run: () => renamePage(app, app.page()) });
  cmd({ id: "move-page", title: "Move this page to another folder", icon: "folder-input", when: hasPage,
    run: () => movePageTo(app, app.page()) });
  cmd({ id: "trash-page", title: "Move this page to the trash", icon: "trash-2", when: hasPage,
    run: () => trashPage(app, app.page()) });
  cmd({ id: "copy-link", title: "Copy a link to this page", icon: "link", when: hasPage, run: () => copyLink(app,
    app.page()) });
  cmd({ id: "reveal-page", title: "Show this page in the file tree", icon: "folder-tree", when: hasPage, run: () => {
    app.sidebar.show("left", "files");
    app.emit("reveal-page", app.page().id);
  } });
  cmd({ id: "bookmark", title: "Bookmark (or remove the bookmark)", icon: "bookmark",
    when: () => Boolean(markFor(app, app.route())), run: () => toggleBookmark(app, markFor(app, app.route())) });
  cmd({ id: "open-in-new-tab", title: "Open this page in a new tab", icon: "external-link", when: hasPage,
    run: () => app.openPage(app.page().id, { newTab: true }) });
  cmd({ id: "import-folder", title: "Import a folder of Markdown files (an Obsidian vault)", icon: "folder-input",
    run: () => importFolder(app) });
}

export async function newFolder(app, parent = "") {
  const name = await app.ui.prompt(parent ? `New folder in ${parent}` : "New folder", {
    label: "Name", ok: "Create", check: (v) => (!v ? "Give the folder a name" : titleProblem(v)),
  });
  if (!name) return null;
  const path = parent ? `${parent}/${name}` : name;
  try {
    await createFolder(app, path);
    app.emit("reveal-folder", path);
    return path;
  } catch (error) {
    app.ui.fail(error);
    return null;
  }
}

export async function renamePage(app, page) {
  if (!page) return;
  const title = await app.ui.prompt("Rename", { value: page.title, label: "Title", ok: "Rename",
    check: (v) => {
      if (!v) return "Give the page a title";
      if (keyOf(v) === keyOf(page.title) && v === page.title) return null;
      try {
        app.wiki.checkTitle(v, page.id);
        return null;
      } catch (e) {
        return e.message;
      }
    } });
  if (!title || title === page.title) return;
  try {
    const { updated } = await app.wiki.rename(page.id, title, { by: "you" });
    app.ui.notify(updated ? `Renamed; links fixed in ${updated} page${updated === 1 ? "" : "s"}` : "Renamed",
      "success");
  } catch (error) {
    app.ui.fail(error);
  }
}

export async function movePageTo(app, page) {
  if (!page) return;
  const folder = await pickFolder(app, { title: `Move “${page.title}” to…` });
  if (folder === null) return;
  try {
    await movePage(app, page.id, folder);
    app.ui.notify(folder ? `Moved to ${folder}` : "Moved to the top folder", "success");
  } catch (error) {
    app.ui.fail(error);
  }
}

export async function trashPage(app, page) {
  if (!page) return;
  if (app.settings.get("confirmDelete") &&
    !(await app.ui.confirm(`Move “${page.title}” to the trash?`, { ok: "Move to the trash", danger: true,
      detail: "You can restore it from the trash." }))) return;
  try {
    await app.wiki.trash(page.id, { by: "you" });
    app.ui.notify(`“${page.title}” is in the trash`);
    // Tabs showing it go back (or home).
    const tabs = app.tabs.list();
    for (let i = tabs.length - 1; i >= 0; i--) {
      if (tabs[i].route.view !== "page" || tabs[i].route.id !== page.id) continue;
      if (i === app.tabs.active()) {
        if (!app.back()) app.open({ view: "home" }, { replace: true });
      } else if (tabs.length > 1) app.tabs.close(i);
    }
  } catch (error) {
    app.ui.fail(error);
  }
}

export function copyLink(app, page) {
  if (!page) return;
  navigator.clipboard?.writeText(pageUrl(page.title))
    .then(() => app.ui.notify("Link copied: paste it in a Claude thread or another page"), app.ui.fail);
}

/** A new note in the inbox (a folder called Inbox when there is one, else the top folder), open for writing. */
export async function quickNote(app) {
  const wiki = app.wiki;
  const inbox = (wiki.folders?.() ?? []).find?.((f) => keyOf(f) === "inbox") ?? "";
  const title = quickNoteTitle(new Date(), (t) => Boolean(wiki.resolve(t)));
  const page = await wiki.create({ title, folder: inbox });
  await app.openPage(page.id, { mode: "edit" });
  return page;
}

export async function openToday(app) {
  if (typeof app.wiki.dailyNote !== "function") throw new Error("Daily notes need the wiki model 0.2");
  const page = await app.wiki.dailyNote(new Date(), app.settings.all());
  if (page) await app.openPage(page.id);
  return page;
}

function importFolder(app) {
  const { el } = app.ui;
  app.ui.modal("Import a folder", (body, close) => {
    const input = el("input", { class: "layr-input", placeholder: "C:\\Users\\you\\Documents\\My vault" });
    const overwrite = el("input", { type: "checkbox" });
    add(body, 
      el("p", { class: "layr-muted" }, "Every .md file becomes a page named after the file, and the pictures they " +
        "embed become attachments. Runs on your PC."),
      el("label", { class: "layr-label" }, "Folder on your PC"), input,
      el("label", { class: "wiki-check" }, overwrite, " Replace pages that have the same title"));
    return {
      ok: "Import",
      focus: input,
      run: async () => {
        if (!input.value.trim()) throw new Error("Give the folder");
        const text = String(await app.tools("import_folder", { path: input.value.trim(),
          overwrite: overwrite.checked }));
        await app.wiki.load();
        close();
        app.emit("changed", { ids: [], all: true, local: true });
        app.ui.notify(text.split("\n")[0], "success");
      },
    };
  });
}
