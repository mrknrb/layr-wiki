// Search: the left sidebar's panel and the `search` view. Full text with snippets; `#tag`, `type:`, `folder:`.
import { add, el, escapeHtml, icon, put } from "./dom.js";
import { filterResults, markWords, parseQuery } from "./pure.js";
import { isBookmarked, toggleBookmark } from "./data.js";
import { tabIcon } from "./shell.js";

const LIMIT = 300;

/** Results for a query: `{rows: [{page, snippet}], total, q}`. */
export function runSearch(app, text) {
  const q = parseQuery(text);
  const not = q.words.filter((w) => w.startsWith("-") && w.length > 1).map((w) => w.slice(1).toLowerCase());
  q.words = q.words.filter((w) => !w.startsWith("-"));
  const words = q.words.join(" ");
  const rows = filterResults(app.wiki.search(words, { limit: 100000 }), q)
    .filter(({ page }) => !not.some((n) => page.title.toLowerCase().includes(n) ||
      page.body.toLowerCase().includes(n)));
  if (!words) rows.sort((a, b) => b.page.updated - a.page.updated);
  return { rows: rows.slice(0, LIMIT), total: rows.length, q };
}

function resultRow(app, { page, snippet }, q, { compact }) {
  const t = page.type ? app.wiki.type?.(page.type) : null;
  const row = el("a", { class: "wiki-result", href: "#", "data-id": page.id },
    el("div", { class: "wiki-result-head" },
      app.settings.get("pageIcons") ? tabIcon(t?.icon ?? "file-text") : null,
      el("span", { class: "wiki-result-title", html: markWords(page.title, q.words, escapeHtml) }),
      page.folder ? el("span", { class: "wiki-result-folder" }, page.folder) : null),
    snippet && q.words.length ? el("div", { class: "wiki-result-snippet", html: markWords(snippet, q.words,
      escapeHtml) }) : null,
    !compact && page.tags.length ? el("div", { class: "wiki-result-tags" },
      ...page.tags.slice(0, 8).map((tag) => el("span", { class: "wiki-tag-chip" }, `#${tag}`))) : null);
  row.addEventListener("click", (e) => {
    e.preventDefault();
    app.openPage(page.id, { newTab: e.ctrlKey || e.metaKey });
  });
  row.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    app.openPage(page.id, { newTab: true });
  });
  return row;
}

/** A search box and its results in `root`; gives {set(query), redraw()}. */
function searchUi(app, root, { query = "", compact, onQuery }) {
  const input = el("input", { class: "layr-input wiki-search-input", type: "search", value: query, spellcheck: "false",
    placeholder: "Search… #tag type:x folder:x", "aria-label": "Search", autocomplete: "off" });
  if (compact) input.id = "searchInput";
  const mark = () => ({ kind: "search", target: input.value.trim(), title: input.value.trim() });
  const bookmarkBtn = el("button", { class: "layr-button ghost icon small", title: "Bookmark this search",
    "aria-label": "Bookmark this search", onclick: () => input.value.trim() && toggleBookmark(app,
      mark()).then(redraw) },
  icon("bookmark"));
  const info = el("div", { class: "wiki-search-info" });
  const list = el("div", { class: "wiki-results" });
  const help = el("div", { class: "wiki-search-help" },
    el("p", {}, "Search titles, aliases, tags and text."),
    el("ul", {},
      el("li", {}, el("code", {}, "#tag"), " pages with a tag (and the tags under it)"),
      el("li", {}, el("code", {}, "type:Paper"), " pages of a type"),
      el("li", {}, el("code", {}, 'folder:"My notes"'), " pages in a folder"),
      el("li", {}, el("code", {}, "-#tag"), " leave a tag out")));
  add(root, el("div", { class: "wiki-search-box" }, input, bookmarkBtn), info, list);
  let timer = null;
  function redraw() {
    const text = input.value.trim();
    bookmarkBtn.classList.toggle("active", Boolean(text) && isBookmarked(mark()));
    bookmarkBtn.hidden = !text;
    if (!text) {
      info.textContent = "";
      put(list, help);
      return;
    }
    const { rows, total, q } = runSearch(app, text);
    put(info, el("span", {}, total === 1 ? "1 page" : `${total} pages`),
      total > rows.length ? el("span", { class: "layr-muted" }, ` (first ${rows.length})`) : null,
      el("span", { class: "wiki-bar-fill" }),
      compact ? el("button", { class: "layr-button ghost small", title: "Open the results in a tab",
        onclick: () => app.open({ view: "search", query: text }) }, icon("external-link"), " Open") : null);
    put(list, ...rows.map((r) => resultRow(app, r, q, { compact })),
      !total && q.words.length && !q.tags.length && !q.types.length && !q.folders.length && !app.wiki.resolve(text)
        ? el("button", { class: "layr-button small wiki-create-from-search",
          onclick: () => app.newPage({ title: q.words.join(" "), folder: app.defaultFolder() }) },
        icon("file-plus"), ` Create “${q.words.join(" ")}”`) : null,
      !total ? el("p", { class: "layr-muted wiki-side-empty" }, "No pages match.") : null);
  }
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      onQuery?.(input.value);
      redraw();
    }, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = list.querySelector(".wiki-result");
      if (first) app.openPage(first.dataset.id, { newTab: e.ctrlKey || e.metaKey });
    } else if (e.key === "Escape" && input.value) {
      e.preventDefault();
      input.value = "";
      onQuery?.("");
      redraw();
    }
  });
  redraw();
  return {
    input,
    redraw,
    set(text) {
      input.value = text;
      onQuery?.(text);
      redraw();
    },
  };
}

export function registerSearch(app) {
  let query = sessionStorage.getItem("wiki.search") ?? "";
  let ui = null;
  const remember = (q) => {
    query = q;
    sessionStorage.setItem("wiki.search", q);
  };

  app.sidebar.register("left", {
    id: "search",
    title: "Search",
    icon: "search",
    order: 20,
    render(root) {
      add(root, el("div", { class: "wiki-side-head" }, el("span", { class: "wiki-side-title" }, "Search")));
      ui = searchUi(app, root, { query, compact: true, onQuery: remember });
      if (!app.ui.narrow()) setTimeout(() => ui?.input.focus(), 0);
      return () => (ui = null);
    },
    update(_root, _app, why) {
      if (why === "changed") ui?.redraw();
    },
  });
  app.on("search", (text) => {
    remember(text);
    ui?.set(text);
    setTimeout(() => ui?.input.focus(), 0);
  });

  app.views.register("search", {
    title: (route) => (route.query ? `Search: ${route.query}` : "Search"),
    icon: "search",
    render(root, route) {
      const wrap = el("div", { class: "wiki-page-wrap wiki-search-view" }, el("h1", { class: "wiki-view-title" },
        "Search"));
      add(root, wrap);
      const s = searchUi(app, wrap, { query: route.query ?? "", compact: false,
        onQuery: (q) => app.updateRoute({ query: q || null }) });
      if (!route.query) setTimeout(() => s.input.focus(), 0);
      const off = app.on("changed", () => s.redraw());
      return off;
    },
    redraw: false,
  });
}
