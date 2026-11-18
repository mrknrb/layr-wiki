// The tags panel (nested `#a/b` as a tree with counts; a click searches) and the bookmarks panel (drag to reorder).
import { add, el, icon, put } from "./dom.js";
import { keyOf } from "../../shared/links.js";
import { tagTree } from "./pure.js";
import { bookmarks, isBookmarked, markTitle, openMark, setBookmarks, toggleBookmark } from "./data.js";
import { tabIcon } from "./shell.js";

const OPEN_TAGS = "wiki.openTags";

export function registerTags(app) {
  const open = new Set(JSON.parse(localStorage.getItem(OPEN_TAGS) ?? "[]"));
  let sortBy = localStorage.getItem("wiki.tagSort") ?? "name";

  function fill(list) {
    let tree = tagTree(app.wiki.live());
    const order = (nodes) => {
      const out = sortBy === "count" ? [...nodes].sort((a,
        b) => b.count - a.count || a.name.localeCompare(b.name)) : nodes;
      return out.map((n) => ({ ...n, children: order(n.children) }));
    };
    tree = order(tree);
    const rows = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const isOpen = open.has(keyOf(n.tag));
        const row = el("div", { class: "wiki-tree-row tag", role: "treeitem", tabindex: "0",
          style: { "--depth": String(depth) },
          title: `#${n.tag}`, "data-tag-row": n.tag },
        el("span", { class: "wiki-tree-chev", onclick: (e) => {
          e.stopPropagation();
          if (!n.children.length) return;
          if (isOpen) open.delete(keyOf(n.tag));
          else open.add(keyOf(n.tag));
          localStorage.setItem(OPEN_TAGS, JSON.stringify([...open]));
          fill(list);
        } }, n.children.length ? icon(isOpen ? "chevron-down" : "chevron-right") : null),
        icon("hash", "wiki-tree-icon"),
        el("span", { class: "wiki-tree-name" }, n.name),
        el("span", { class: "wiki-tree-count" }, String(n.count)));
        const search = (e) => app.search(`#${n.tag}`, e.ctrlKey || e.metaKey);
        row.addEventListener("click", search);
        row.addEventListener("keydown", (e) => e.key === "Enter" && search(e));
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const mark = { kind: "tag", target: n.tag, title: `#${n.tag}` };
          app.ui.menu([
            { label: "Search for it", icon: "search", run: () => app.search(`#${n.tag}`) },
            { label: "Open the results in a new tab", icon: "open_in_new",
              run: () => app.open({ view: "search", query: `#${n.tag}` }, { newTab: true }) },
            { label: isBookmarked(mark) ? "Remove bookmark" : "Bookmark", icon: "bookmark",
              run: () => toggleBookmark(app, mark) },
            typeof app.views?.createFor === "function" ? { label: "Open as a table", icon: "table",
              run: () => Promise.resolve(app.views.createFor({ tag: n.tag })).catch(app.ui.fail) } : null,
          ].filter(Boolean), e).catch(app.ui.fail);
        });
        rows.push(row);
        if (isOpen) walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    put(list, ...(rows.length ? rows : [el("div", { class: "wiki-side-empty" },
      el("p", {}, "No tags yet."), el("p", { class: "layr-muted" },
        "Write #tag in a page, or tags: in its properties; " +
        "#area/topic nests."))]));
  }

  app.sidebar.register("left", {
    id: "tags",
    title: "Tags",
    icon: "tags",
    order: 30,
    render(root) {
      const list = el("div", { class: "wiki-tree", role: "tree", "aria-label": "Tags" });
      add(root, el("div", { class: "wiki-side-head" }, el("span", { class: "wiki-side-title" }, "Tags"),
        el("span", { class: "wiki-bar-fill" }),
        el("button", { class: "layr-button ghost icon small", title: "Sort", "aria-label": "Sort", onclick: (e) =>
          app.ui.menu([["name", "By name"], ["count", "Most used first"]].map(([id, label]) => ({ label,
            checked: sortBy === id,
            run: () => {
              sortBy = id;
              localStorage.setItem("wiki.tagSort", id);
              fill(list);
            } })), e).catch(app.ui.fail) }, icon("arrow-down-up"))), list);
      fill(list);
    },
    update(root, _app, why) {
      const list = root.querySelector(".wiki-tree");
      if (why === "changed" && list) fill(list);
    },
  });
}

export function registerBookmarks(app) {
  let dragFrom = null;

  function fill(list) {
    const marks = bookmarks();
    put(list, ...(marks.length ? marks.map((m, i) => {
      const missing = m.kind === "page" && !app.wiki.find(m.target);
      const name = { page: null, search: "search", tag: "hash", folder: "folder", view: "layout-grid" }[m.kind];
      const page = m.kind === "page" ? app.wiki.find(m.target) : null;
      const t = page?.type ? app.wiki.type?.(page.type) : null;
      const row = el("div", { class: `wiki-tree-row mark${missing ? " missing" : ""}`, draggable: "true", tabindex: "0",
        "data-index": String(i), title: missing ? "This page is gone" : markTitle(app, m), style: { "--depth": "0" } },
      el("span", { class: "wiki-tree-chev" }),
      tabIcon(name ?? t?.icon ?? "file-text"),
      el("span", { class: "wiki-tree-name" }, markTitle(app, m)),
      el("button", { class: "wiki-row-x", title: "Remove bookmark", "aria-label": "Remove bookmark", onclick: (e) => {
        e.stopPropagation();
        setBookmarks(app, marks.filter((_, k) => k !== i)).catch(app.ui.fail);
      } }, icon("x")));
      const go = (e) => openMark(app, m, { newTab: e.ctrlKey || e.metaKey });
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => e.key === "Enter" && go(e));
      row.addEventListener("auxclick", (e) => e.button === 1 && openMark(app, m, { newTab: true }));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        app.ui.menu([
          { label: "Open", icon: "arrow_forward", run: () => openMark(app, m) },
          { label: "Open in a new tab", icon: "open_in_new", run: () => openMark(app, m, { newTab: true }) },
          { label: "Rename…", icon: "edit", disabled: m.kind === "page", run: async () => {
            const title = await app.ui.prompt("Bookmark name", { value: m.title ?? "", ok: "Save" });
            if (title) await setBookmarks(app, marks.map((x, k) => (k === i ? { ...x, title } : x)));
          } },
          { label: "Move up", icon: "arrow_upward", disabled: i === 0, run: () => move(i, i - 1) },
          { label: "Move down", icon: "arrow_downward", disabled: i === marks.length - 1, run: () => move(i, i + 1) },
          "-",
          { label: "Remove bookmark", icon: "delete", danger: true,
            run: () => setBookmarks(app, marks.filter((_, k) => k !== i)) },
        ], e).catch(app.ui.fail);
      });
      row.addEventListener("dragstart", (e) => {
        dragFrom = i;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-wiki-bookmark", String(i));
        if (page) e.dataTransfer.setData("text/plain", `[[${page.title}]]`);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        dragFrom = null;
        for (const n of list.querySelectorAll(".dragging, .drop-before, .drop-after")) {
          n.classList.remove("dragging", "drop-before", "drop-after");
        }
      });
      row.addEventListener("dragover", (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        row.classList.toggle("drop-after", after);
        row.classList.toggle("drop-before", !after);
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
      row.addEventListener("drop", (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        let to = i + (e.clientY > r.top + r.height / 2 ? 1 : 0);
        if (dragFrom < to) to -= 1;
        move(dragFrom, to);
      });
      return row;
    }) : [el("div", { class: "wiki-side-empty" }, el("p", {}, "No bookmarks yet."),
      el("p", { class: "layr-muted" },
        "Bookmark a page, a folder, a search or a view from its menu (⋯ or right-click).")),
    ]));
    function move(from, to) {
      if (from === to || to < 0 || to >= marks.length) return;
      const next = [...marks];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      setBookmarks(app, next).catch(app.ui.fail);
    }
  }

  app.sidebar.register("left", {
    id: "bookmarks",
    title: "Bookmarks",
    icon: "bookmark",
    order: 40,
    render(root) {
      const list = el("div", { class: "wiki-tree", role: "list", "aria-label": "Bookmarks" });
      const route = app.route();
      add(root, el("div", { class: "wiki-side-head" }, el("span", { class: "wiki-side-title" }, "Bookmarks"),
        el("span", { class: "wiki-bar-fill" }),
        el("button", { class: "layr-button ghost icon small", title: "Bookmark what is open",
          "aria-label": "Bookmark what is open",
          disabled: route.view === "home" || route.view === "missing" ? true : null,
          onclick: () => app.commands.run("bookmark").catch(app.ui.fail) }, icon("bookmark-plus"))), list);
      fill(list);
    },
  });
}
