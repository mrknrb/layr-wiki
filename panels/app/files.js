// The left sidebar's file tree: folders nested, pages in them; open, drag to move, context menus, sorting.
import { add, el, icon, put } from "./dom.js";
import { keyOf } from "../../shared/links.js";
import { buildTree, folderChain, movedFolderPath, SORTS } from "./pure.js";
import { deleteFolder, folders, isBookmarked, movePage, renameFolder, toggleBookmark } from "./data.js";
import { copyLink, movePageTo, newFolder, renamePage, trashPage } from "./commands.js";
import { pickFolder } from "./switcher.js";
import { tabIcon } from "./shell.js";

const EXPANDED = "wiki.expanded";
const SORT = "wiki.fileSort";
const DRAG = "application/x-wiki-item";

function readExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED) ?? "[]").map(keyOf));
  } catch {
    return new Set();
  }
}

export function registerFiles(app) {
  const expanded = readExpanded();
  const saveExpanded = () => localStorage.setItem(EXPANDED, JSON.stringify([...expanded].slice(-500)));
  let sort = localStorage.getItem(SORT) ?? "name";
  let treeEl = null;
  let revealId = null;

  const pageIcon = (p) => {
    if (!app.settings.get("pageIcons")) return null;
    const t = p.type ? app.wiki.type?.(p.type) : null;
    return tabIcon(t?.icon ?? "file-text");
  };

  function draw(root) {
    const head = el("div", { class: "wiki-side-head" },
      el("span", { class: "wiki-side-title" }, "Files"),
      el("span", { class: "wiki-bar-fill" }),
      el("button", { class: "layr-button ghost icon small", title: "New page", "aria-label": "New page",
        onclick: () => app.newPage({ folder: app.defaultFolder() }) }, icon("file-plus")),
      el("button", { class: "layr-button ghost icon small", title: "New folder", "aria-label": "New folder",
        onclick: () => newFolder(app, "") }, icon("folder-plus")),
      el("button", { class: "layr-button ghost icon small", title: "Sort", "aria-label": "Sort", onclick: (e) =>
        app.ui.menu(Object.entries(SORTS).map(([id, s]) => ({ label: s.label, checked: id === sort, run: () => {
          sort = id;
          localStorage.setItem(SORT, id);
          fill();
        } })), e).catch(app.ui.fail) }, icon("arrow-down-up")),
      el("button", { class: "layr-button ghost icon small", title: "Collapse all", "aria-label": "Collapse all",
        onclick: () => {
          expanded.clear();
          saveExpanded();
          fill();
        } }, icon("chevrons-down-up")));
    treeEl = el("div", { class: "wiki-tree", role: "tree", "aria-label": "Pages and folders" });
    put(root, head, treeEl);
    dropTarget(treeEl, "", true);
    treeEl.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".wiki-tree-row")) return;
      e.preventDefault();
      app.ui.menu([
        { label: "New page", icon: "note_add", run: () => app.newPage({ folder: "" }) },
        { label: "New folder", icon: "create_new_folder", run: () => newFolder(app, "") },
      ], e).catch(app.ui.fail);
    });
    fill();
  }

  /** The tree's rows again (the head stays). */
  function fill() {
    if (!treeEl) return;
    const scroll = treeEl.scrollTop;
    const tree = buildTree(app.wiki.live(), folders(app), sort);
    const active = app.route().view === "page" ? app.route().id : null;
    if (revealId) {
      const p = app.wiki.pages.get(revealId);
      for (const f of folderChain(p?.folder)) expanded.add(keyOf(f));
      saveExpanded();
    }
    const rows = [];
    const walk = (node, depth) => {
      for (const f of node.folders) {
        const open = expanded.has(keyOf(f.path));
        rows.push(folderRow(f, depth, open));
        if (open) walk(f, depth + 1);
      }
      for (const p of node.pages) rows.push(pageRow(p, depth, p.id === active));
    };
    walk(tree, 0);
    if (!rows.length) {
      rows.push(el("div", { class: "wiki-side-empty" }, el("p", {}, "No pages yet."),
        el("button", { class: "layr-button small primary", onclick: () => app.newPage({ folder: "" }) }, "New page")));
    }
    put(treeEl, ...rows);
    treeEl.scrollTop = scroll;
    if (revealId) {
      treeEl.querySelector(`.wiki-tree-row.page[data-id="${CSS.escape(revealId)}"]`)?.scrollIntoView({ block:
        "nearest" });
      revealId = null;
    }
  }

  const indent = (depth) => ({ "--depth": String(depth) });

  function folderRow(f, depth, open) {
    const row = el("div", { class: "wiki-tree-row folder", role: "treeitem", "aria-expanded": String(open),
      tabindex: "0",
      draggable: "true", "data-folder": f.path, title: f.path, style: indent(depth) },
    el("span", { class: "wiki-tree-chev" }, icon(open ? "chevron-down" : "chevron-right")),
    icon(open ? "folder-open" : "folder", "wiki-tree-icon"),
    el("span", { class: "wiki-tree-name" }, f.name),
    el("span", { class: "wiki-tree-count" }, f.count ? String(f.count) : ""));
    const toggle = () => {
      if (open) expanded.delete(keyOf(f.path));
      else expanded.add(keyOf(f.path));
      saveExpanded();
      fill();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || (e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) {
        e.preventDefault();
        toggle();
        setTimeout(() => treeEl.querySelector(`[data-folder="${CSS.escape(f.path)}"]`)?.focus(), 0);
      }
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      folderMenu(f, e);
    });
    drag(row, { kind: "folder", path: f.path }, `${f.name}`);
    dropTarget(row, f.path);
    return row;
  }

  function pageRow(p, depth, active) {
    const row = el("a", { class: `wiki-tree-row page${active ? " active" : ""}`, role: "treeitem", href: "#",
      draggable: "true",
      "data-id": p.id, title: p.folder ? `${p.folder}/${p.title}` : p.title, style: indent(depth),
      "aria-current": active ? "page" : null },
    el("span", { class: "wiki-tree-chev" }),
    pageIcon(p),
    el("span", { class: "wiki-tree-name" }, p.title),
    p.by === "ai" && Date.now() - p.updated < 86400000 ? el("span", { class: "wiki-ai-dot",
      title: "Changed by AI today" }) : null);
    row.addEventListener("click", (e) => {
      e.preventDefault();
      app.openPage(p.id, { newTab: e.ctrlKey || e.metaKey });
    });
    row.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
    row.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      app.openPage(p.id, { newTab: true });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      pageMenu(p, e);
    });
    drag(row, { kind: "page", id: p.id }, p.title, `[[${p.title}]]`);
    return row;
  }

  // ---------- context menus ----------

  function pageMenu(p, e) {
    const mark = { kind: "page", target: p.id, title: p.title };
    app.ui.menu([
      { label: "Open in a new tab", icon: "open_in_new", run: () => app.openPage(p.id, { newTab: true }) },
      "-",
      { label: "Rename…", icon: "edit", run: () => renamePage(app, p) },
      { label: "Move to…", icon: "drive_file_move", run: () => movePageTo(app, p) },
      { label: isBookmarked(mark) ? "Remove bookmark" : "Bookmark", icon: "bookmark", run: () => toggleBookmark(app,
        mark) },
      { label: "Copy link", icon: "link", run: () => copyLink(app, p) },
      ...app.pageMenu.items(p),
      "-",
      { label: "Move to the trash", icon: "delete", danger: true, run: () => trashPage(app, p) },
    ], e).catch(app.ui.fail);
  }

  function folderMenu(f, e) {
    const mark = { kind: "folder", target: f.path, title: f.name };
    app.ui.menu([
      { label: "New page here", icon: "note_add", run: () => app.newPage({ folder: f.path }) },
      { label: "New folder here", icon: "create_new_folder", run: () => newFolder(app, f.path).then((p) => {
        if (p) expanded.add(keyOf(f.path));
      }) },
      "-",
      { label: "Rename…", icon: "edit", run: () => renameFolderAsk(f) },
      { label: "Move to…", icon: "drive_file_move", run: () => moveFolderAsk(f) },
      { label: isBookmarked(mark) ? "Remove bookmark" : "Bookmark", icon: "bookmark", run: () => toggleBookmark(app,
        mark) },
      { label: "Search in this folder", icon: "search", run: () => app.search(`folder:"${f.path}" `) },
      typeof app.views?.createFor === "function" ? { label: "Open as a table", icon: "table",
        run: () => Promise.resolve(app.views.createFor({ folder: f.path })).catch(app.ui.fail) } : null,
      typeof app.exportFolder === "function" ? { label: "Export", icon: "download", items: [
        ["Web pages (HTML)", "html"], ["Markdown files", "markdown"], ["Word (.docx)", "docx"],
      ].map(([label, format]) => ({ label,
        run: () => Promise.resolve(app.exportFolder(f.path, format)).catch(app.ui.fail) })) } : null,
      "-",
      { label: "Delete folder…", icon: "delete", danger: true, run: () => deleteFolderAsk(f) },
    ], e).catch(app.ui.fail);
  }

  async function renameFolderAsk(f) {
    const name = await app.ui.prompt("Rename folder", { value: f.name, label: "Name", ok: "Rename" });
    if (!name || name === f.name) return;
    const parent = f.path.split("/").slice(0, -1).join("/");
    await moveFolder(f.path, parent ? `${parent}/${name}` : name);
  }

  async function moveFolderAsk(f) {
    const into = await pickFolder(app, { title: `Move “${f.name}” into…`, except: f.path });
    if (into === null) return;
    const to = movedFolderPath(f.path, into);
    if (to) await moveFolder(f.path, to);
  }

  async function moveFolder(from, to) {
    try {
      await renameFolder(app, from, to);
      if (expanded.has(keyOf(from))) expanded.add(keyOf(to));
      saveExpanded();
      app.ui.notify(`Moved to ${to}`, "success");
    } catch (error) {
      app.ui.fail(error);
    }
  }

  async function deleteFolderAsk(f) {
    if (!f.count) {
      try {
        await deleteFolder(app, f.path);
      } catch (error) {
        app.ui.fail(error);
      }
      return;
    }
    const ok = await app.ui.confirm(`Delete the folder “${f.path}”?`, { danger: true, ok: "Move pages to the trash",
      detail: `Its ${f.count} page${f.count === 1 ? "" : "s"} go to the trash (you can restore them from there).` });
    if (!ok) return;
    try {
      await deleteFolder(app, f.path, { trashPages: true });
    } catch (error) {
      app.ui.fail(error);
    }
  }

  // ---------- drag and drop ----------

  let dragging = null;
  function drag(row, item, label, text = null) {
    row.addEventListener("dragstart", (e) => {
      dragging = item;
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData(DRAG, JSON.stringify(item));
      if (text) e.dataTransfer.setData("text/plain", text);
      row.classList.add("dragging");
      void label;
    });
    row.addEventListener("dragend", () => {
      dragging = null;
      row.classList.remove("dragging");
      for (const n of document.querySelectorAll(".wiki-tree .drop")) n.classList.remove("drop");
    });
  }

  /** Dropping on a folder's row (or the tree's empty space: the top folder) moves what was dragged into it. */
  function dropTarget(node, folder, isRoot = false) {
    let openTimer = null;
    node.addEventListener("dragover", (e) => {
      if (!dragging || (isRoot && e.target.closest(".wiki-tree-row.folder"))) return;
      if (dragging.kind === "folder" && movedFolderPath(dragging.path, folder) === null) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      node.classList.add("drop");
      // Hovering over a closed folder opens it, so a page can go deeper.
      if (!isRoot && !openTimer && !expanded.has(keyOf(folder))) {
        openTimer = setTimeout(() => {
          expanded.add(keyOf(folder));
          saveExpanded();
          fill();
        }, 700);
      }
    });
    node.addEventListener("dragleave", (e) => {
      if (node.contains(e.relatedTarget)) return;
      node.classList.remove("drop");
      clearTimeout(openTimer);
      openTimer = null;
    });
    node.addEventListener("drop", async (e) => {
      clearTimeout(openTimer);
      openTimer = null;
      node.classList.remove("drop");
      if (!dragging || (isRoot && e.target.closest(".wiki-tree-row.folder"))) return;
      e.preventDefault();
      e.stopPropagation();
      const item = dragging;
      dragging = null;
      try {
        if (item.kind === "page") await movePage(app, item.id, folder);
        else {
          const to = movedFolderPath(item.path, folder);
          if (to) await moveFolder(item.path, to);
        }
      } catch (error) {
        app.ui.fail(error);
      }
    });
  }

  app.on("reveal-page", (id) => {
    revealId = id;
    fill();
  });
  app.on("reveal-folder", (path) => {
    for (const f of folderChain(path)) expanded.add(keyOf(f));
    saveExpanded();
    fill();
    setTimeout(() =>
      treeEl?.querySelector(`[data-folder="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" }), 0);
  });

  app.sidebar.register("left", {
    id: "files",
    title: "Files",
    icon: "folder-tree",
    order: 10,
    render(root) {
      // Opening a page reveals it in the tree.
      if (app.route().view === "page") revealId = app.route().id;
      draw(root);
      return () => (treeEl = null);
    },
    update(root, _app, why) {
      if (!treeEl || !root.contains(treeEl)) return draw(root);
      if (why === "route" && app.route().view === "page") revealId = app.route().id;
      fill();
    },
  });
}
