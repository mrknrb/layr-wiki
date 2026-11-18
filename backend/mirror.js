// The folder copy: every page as `<root>/<its folder>/<Title>.md` (the wiki's folders as real folders, empty ones
// too) and every attachment as `<root>/attachments/<name>`, kept up to date on this PC, so the knowledge is always
// in plain files (Obsidian opens the folder as a vault, git can track
// it, any backup takes it). The wiki in layr stays the truth: the copy is written from it, never read back (import a
// folder with wiki__import_folder). A file someone changed in the folder is never lost: before it is overwritten or
// removed it is copied to `.layr-wiki/overwritten/` (a page moved to another folder counts as removed from the old
// one). `.layr-wiki/state.json` remembers what was written, and which folders are ours: a folder the wiki no longer
// has is removed when it is empty, never when it holds files of someone else's.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanFolder } from "../shared/folders.js";
import { keyOf } from "../shared/links.js";

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const hash = (data) => createHash("sha256").update(data).digest("hex");

export const defaultFolder = () => path.join(os.homedir(), "Documents", "layr wiki");

/** A page title as a file name (titles are already safe; this guards against older or synced odd ones). */
export function fileNameOf(title) {
  let name = String(title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .trim()
    .replace(/\.+$/, "");
  if (!name) name = "Untitled";
  if (RESERVED.test(name)) name = `_${name}`;
  return name;
}

/** A wiki folder path as a relative folder on disk ("" for the top), each segment a safe name. */
export const dirOf = (folder) => cleanFolder(folder).split("/").filter(Boolean).map(fileNameOf).join("/");

/** A page's file, relative to the root, with "/" between: "Projects/Thesis/Plan.md". */
const relFile = (folder, name) => (dirOf(folder) ? `${dirOf(folder)}/${name}.md` : `${name}.md`);

const README = `This folder is a copy of your layr wiki, written by layr's Wiki plugin.

- Every page is a Markdown file, in the wiki's folders; attachments are in attachments/. Obsidian can open this
  folder as a vault.
- Edit your pages in layr: changes made here are overwritten by the next copy (the overwritten file is kept in
  .layr-wiki/overwritten/). To bring files in, use "Import a folder" in the Wiki panel.
`;

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export class Mirror {
  /**
   * `getWiki({reload})` → the loaded Wiki; `files`: attachments (Files); `settings()` → `{mirror, folder}`;
   * `log(...)`. `fsx` replaces node's fs in tests.
   */
  constructor({ getWiki, files, settings, log = () => {} }) {
    this.getWiki = getWiki;
    this.files = files;
    this.settings = settings;
    this.log = log;
    this.timer = null;
    this.running = null;
    this.again = false;
    this.state = { enabled: null, folder: null, lastRun: null, pages: 0, folders: 0, written: 0, removed: 0,
      attachments: 0, error: null, attachmentsError: null };
  }

  status() {
    return { ...this.state };
  }

  /** Run soon (changes come in bursts). */
  schedule(ms = 1500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run().catch((e) => this.log(`folder copy failed: ${e.message}`)), ms);
    this.timer.unref?.();
  }

  /** Write the copy now; a run asked for while one runs follows it. */
  async run({ reload = false } = {}) {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        await this.once(reload);
      } finally {
        this.running = null;
      }
      if (this.again) {
        this.again = false;
        await this.run();
      }
    })();
    return this.running;
  }

  async once(reload) {
    const { mirror = true, folder = "" } = (await this.settings()) ?? {};
    const root = String(folder ?? "").trim() || defaultFolder();
    this.state.enabled = Boolean(mirror);
    this.state.folder = root;
    if (!mirror) return;
    try {
      await this.writeAll(root, reload);
      this.state.error = null;
    } catch (error) {
      this.state.error = error.message;
      throw error;
    } finally {
      this.state.lastRun = Date.now();
    }
  }

  async loadState(root) {
    try {
      const s = JSON.parse(await readFile(path.join(root, ".layr-wiki", "state.json"), "utf8"));
      return { pages: s.pages ?? {}, files: s.files ?? {}, folders: s.folders ?? [] };
    } catch {
      return { pages: {}, files: {}, folders: [] };
    }
  }

  /** Before replacing or removing `file`: keep it when it isn't what was written there last. */
  async keepIfChanged(root, file, writtenHash) {
    const text = await readText(file);
    if (text === null || hash(text) === writtenHash) return;
    const dir = path.join(root, ".layr-wiki", "overwritten");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(file, path.join(dir, `${stamp} ${path.basename(file)}`));
    this.log(`kept a changed file before replacing it: ${path.basename(file)}`);
  }

  async writeAll(root, reload) {
    const wiki = await this.getWiki({ reload });
    await mkdir(path.join(root, ".layr-wiki"), { recursive: true });
    const readme = path.join(root, ".layr-wiki", "README.txt");
    if ((await readText(readme)) !== README) await writeFile(readme, README);
    const prev = await this.loadState(root);
    // Folders first (empty ones too), so pages can go in.
    const folders = (wiki.folders?.() ?? []).map(dirOf).filter(Boolean);
    for (const dir of folders) await mkdir(path.join(root, dir), { recursive: true });
    const next = { pages: {}, files: { ...prev.files }, folders };
    const taken = new Set(); // lowercase relative files of this run
    let written = 0;
    let removed = 0;
    const pages = wiki.live().sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    const files = new Map();
    for (const page of pages) {
      let name = fileNameOf(page.title);
      for (let n = 2; taken.has(keyOf(relFile(page.folder, name))); n++) name = `${fileNameOf(page.title)} (${n})`;
      const file = relFile(page.folder, name);
      taken.add(keyOf(file));
      files.set(page.id, file);
    }
    for (const page of pages) {
      const file = files.get(page.id);
      const full = path.join(root, file);
      const content = page.markdown.endsWith("\n") ? page.markdown : `${page.markdown}\n`;
      const contentHash = hash(content);
      const before = prev.pages[page.id];
      if (before && before.file !== file) {
        const old = path.join(root, before.file);
        // Renamed or moved: move the old file when it is ours, so the new one starts clean (case-only renames
        // included); a file another page writes now is left to that page.
        if (keyOf(before.file) === keyOf(file)) {
          await this.keepIfChanged(root, old, before.hash);
          await rename(old, full).catch(() => {});
        } else if (!taken.has(keyOf(before.file))) {
          await this.keepIfChanged(root, old, before.hash);
          await rm(old, { force: true });
          removed++;
        }
      }
      const disk = await readText(full);
      if (disk !== content) {
        const writtenHash = before && keyOf(before.file) === keyOf(file) ? before.hash : null;
        if (disk !== null) await this.keepIfChanged(root, full, writtenHash);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, content);
        written++;
      }
      next.pages[page.id] = { file, hash: contentHash };
    }
    for (const [id, before] of Object.entries(prev.pages)) {
      if (next.pages[id]) continue;
      if (taken.has(keyOf(before.file))) continue;
      const old = path.join(root, before.file);
      await this.keepIfChanged(root, old, before.hash);
      await rm(old, { force: true });
      removed++;
    }
    // Folders of ours the wiki no longer has (and the folders pages left): removed when empty, deepest first.
    const keep = new Set(folders.map(keyOf));
    const gone = new Set([...prev.folders, ...Object.values(prev.pages).map((p) => path.posix.dirname(p.file))]
      .map((d) => (d === "." ? "" : d)).filter((d) => d && !keep.has(keyOf(d))));
    for (const dir of [...gone].sort((a, b) => b.split("/").length - a.split("/").length)) {
      for (let d = dir; d && !keep.has(keyOf(d)); d = path.posix.dirname(d) === "." ? "" : path.posix.dirname(d)) {
        if (!(await this.removeIfEmpty(path.join(root, d)))) break;
      }
    }
    Object.assign(this.state, { pages: pages.length, folders: folders.length, written, removed });
    await this.writeState(root, next);
    await this.copyAttachments(root, next);
    await this.writeState(root, next);
  }

  /** Remove a directory when nothing is in it; true when it is gone. */
  async removeIfEmpty(dir) {
    const entries = await readdir(dir).catch(() => null);
    if (entries === null) return true;
    if (entries.length) return false;
    await rmdir(dir).catch(() => {});
    return true;
  }

  async writeState(root, state) {
    const file = path.join(root, ".layr-wiki", "state.json");
    await writeFile(file, JSON.stringify(state, null, 1));
  }

  async copyAttachments(root, state) {
    let records;
    try {
      records = await this.files.list();
    } catch (error) {
      this.state.attachmentsError = error.message;
      return;
    }
    const dir = path.join(root, "attachments");
    let copied = 0;
    this.state.attachmentsError = null;
    for (const record of records) {
      const full = path.join(dir, record.name);
      if (state.files[record.name] === record.sha256 && (await stat(full).catch(() => null))) continue;
      try {
        const { bytes } = await this.files.download(record.name);
        await mkdir(dir, { recursive: true });
        await writeFile(full, Buffer.from(bytes));
        state.files[record.name] = record.sha256;
        copied++;
      } catch (error) {
        this.state.attachmentsError = error.message;
        if (/database update|Sign in/.test(error.message)) break;
      }
    }
    this.state.attachments = Object.keys(state.files).length;
    if (copied) this.log(`copied ${copied} attachment(s) to the folder`);
  }
}
