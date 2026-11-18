// What the shell reads and changes besides pages: folders and bookmarks, through the wiki model's methods
// (PLAN.md › Data). Each call works with an older model too, so the panel never breaks on a missing method.
import { keyOf } from "../../shared/links.js";
import { allFolders } from "./pure.js";

const BOOKMARKS = "bookmarks";

/** Every folder path (the model's, else read from the pages), sorted. */
export function folders(app) {
  let list = [];
  try {
    list = app.wiki.folders?.() ?? [];
  } catch {
    list = [];
  }
  return allFolders(app.wiki.live(), Array.isArray(list) ? list : []);
}

const needModel = (what) => {
  throw new Error(`${what} needs the wiki model with folders (0.2)`);
};

export async function createFolder(app, path) {
  if (!app.wiki.createFolder) needModel("A new folder");
  await app.wiki.createFolder(path);
}

export async function renameFolder(app, from, to) {
  if (!app.wiki.renameFolder) needModel("Renaming a folder");
  await app.wiki.renameFolder(from, to);
}

export async function deleteFolder(app, path, opts = {}) {
  if (!app.wiki.deleteFolder) needModel("Deleting a folder");
  await app.wiki.deleteFolder(path, opts);
}

export async function movePage(app, id, folder) {
  if (!app.wiki.move) needModel("Moving a page");
  const page = app.wiki.pages.get(id);
  if (page && keyOf(page.folder ?? "") === keyOf(folder)) return;
  await app.wiki.move(id, folder, { by: "you" });
}

// ---------- bookmarks: [{kind: "page"|"view"|"search"|"folder"|"tag", target, title}] ----------

let cache = null;

/** Read the bookmarks again (start, and when they changed elsewhere). */
export async function loadBookmarks(app) {
  try {
    const list = app.wiki.bookmarks ? await app.wiki.bookmarks() : await app.wiki.a.dataGet(BOOKMARKS);
    cache = Array.isArray(list) ? list.filter((b) => b && b.kind && b.target !== undefined) : [];
  } catch {
    cache = cache ?? [];
  }
  return cache;
}

export const bookmarks = () => cache ?? [];

export async function setBookmarks(app, list) {
  cache = list;
  if (app.wiki.setBookmarks) await app.wiki.setBookmarks(list);
  else {
    await app.wiki.a.dataSet(BOOKMARKS, list);
    app.wiki.a.emit?.("wiki:changed", { ids: [], bookmarks: true });
  }
  app.emit("bookmarks");
}

const sameMark = (a, b) => a.kind === b.kind && keyOf(a.target) === keyOf(b.target);

export const isBookmarked = (mark) => bookmarks().some((b) => sameMark(b, mark));

/** Add the bookmark, or take it away when it is there. Gives true when it is bookmarked now. */
export async function toggleBookmark(app, mark) {
  const list = bookmarks();
  const on = !list.some((b) => sameMark(b, mark));
  await setBookmarks(app, on ? [...list, mark] : list.filter((b) => !sameMark(b, mark)));
  app.ui.notify(on ? `Bookmarked “${mark.title}”` : `Bookmark “${mark.title}” removed`);
  return on;
}

/** The bookmark for what a route shows (null: nothing to bookmark). */
export function markFor(app, route) {
  if (!route) return null;
  if (route.view === "page") {
    const p = app.wiki.pages.get(route.id);
    return p ? { kind: "page", target: p.id, title: p.title } : null;
  }
  if (route.view === "search") return route.query ? { kind: "search", target: route.query, title: route.query } : null;
  if (route.view === "missing" || route.view === "home") return null;
  // A saved view is its id; any other view is its route (the model keeps only kind, target and title).
  const target = route.view === "view" ? route.id : `route:${JSON.stringify(route)}`;
  return { kind: "view", target, title: app.routeTitle(route) };
}

/** Open what a bookmark points at. */
export function openMark(app, mark, { newTab = false } = {}) {
  if (mark.kind === "page") return app.openPage(mark.target, { newTab });
  if (mark.kind === "search") return app.open({ view: "search", query: mark.target }, { newTab });
  if (mark.kind === "tag") return app.open({ view: "search", query: `#${mark.target}` }, { newTab });
  if (mark.kind === "folder") {
    app.sidebar.show("left", "files");
    return app.emit("reveal-folder", mark.target);
  }
  if (String(mark.target).startsWith("route:")) {
    try {
      return app.open(JSON.parse(String(mark.target).slice(6)), { newTab });
    } catch {
      // a broken bookmark: fall through to a saved view
    }
  }
  return app.open({ view: "view", id: mark.target }, { newTab });
}

/** A bookmark's page still exists (its title may have changed: the title shown follows the page). */
export function markTitle(app, mark) {
  if (mark.kind === "page") return app.wiki.find(mark.target)?.title ?? mark.title;
  return mark.title ?? String(mark.target);
}
