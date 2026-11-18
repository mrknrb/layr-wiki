// Folders, nested like Obsidian's: a page's `folder` is "" (the top) or a path "Projects/Thesis", each segment a valid
// title (titleProblem), "/" between. A title stays unique across the whole wiki, so links stay [[Title]] and a page's
// folder is only where it is kept (and where the folder copy writes it). Folders compare by their lowercase form, the
// way Windows and the links do. Empty folders are data `folder/<lowercase path>` = `{path}`. Pure (tested in
// test/shared.test.js).
import { cleanTitle, keyOf, titleProblem } from "./links.js";

export const FOLDER_PREFIX = "folder/";

/** The data key of a folder's record. */
export const folderKey = (path) => `${FOLDER_PREFIX}${keyOf(cleanFolder(path))}`;

/** A folder path written any way ("\\a\\ b /c/", null) → "a/b/c" (segments trimmed, empty ones dropped). */
export function cleanFolder(path) {
  return String(path ?? "")
    .split(/[\\/]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("/");
}

/** A folder path made valid (each segment like cleanTitle), for imports. */
export const fixFolder = (path) => cleanFolder(path).split("/").filter(Boolean).map(cleanTitle).join("/");

/** Why `path` can't be a folder, or null when it can ("" is the top and always fine). */
export function folderProblem(path) {
  const clean = cleanFolder(path);
  if (!clean) return null;
  if (clean.length > 400) return "A folder path can be at most 400 characters";
  for (const segment of clean.split("/")) {
    const problem = titleProblem(segment);
    if (problem) {
      const reason = problem.replace(/^A page needs a title/, "a name is needed").replace(/^A title/, "a name");
      return `Folder "${segment}": ${reason}`;
    }
  }
  return null;
}

/** `cleanFolder`, or an error with the reason. */
export function checkFolder(path) {
  const problem = folderProblem(path);
  if (problem) throw new Error(problem);
  return cleanFolder(path);
}

/** The folder holding `path` ("" for a top folder or a top page). */
export function parentOf(path) {
  const clean = cleanFolder(path);
  const at = clean.lastIndexOf("/");
  return at < 0 ? "" : clean.slice(0, at);
}

/** The last segment of a path (a folder's own name, or a page path's title). */
export function nameOf(path) {
  const clean = cleanFolder(path);
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** A folder and a name (a subfolder or a page title) → their path. */
export const joinPath = (folder, name) => cleanFolder(`${folder ?? ""}/${name ?? ""}`);

/** Is `path` the folder `folder` itself or inside it, any depth (any case)? Everything is inside the top (""). */
export function isInside(path, folder) {
  const f = keyOf(cleanFolder(folder));
  if (!f) return true;
  const p = keyOf(cleanFolder(path));
  return p === f || p.startsWith(`${f}/`);
}

/** Every folder from the top down to `path`: "a/b/c" → ["a", "a/b", "a/b/c"]. */
export function ancestors(path) {
  const parts = cleanFolder(path).split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** `path` with its `from` part replaced by `to` (a folder rename): `moveInto("a/b/c", "a/b", "x")` → "x/c". */
export function moveInto(path, from, to) {
  const p = cleanFolder(path);
  const f = cleanFolder(from);
  if (!isInside(p, f) || !f) return p;
  return joinPath(to, p.slice(f.length + 1));
}

/** Sort order for folder paths: segment by segment, any case (so a folder's subfolders follow it). */
export function compareFolders(a, b) {
  const x = cleanFolder(a).split("/");
  const y = cleanFolder(b).split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = x[i].localeCompare(y[i], undefined, { sensitivity: "base", numeric: true });
    if (c) return c;
  }
  return x.length - y.length;
}
