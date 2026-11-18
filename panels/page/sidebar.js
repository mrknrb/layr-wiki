// The right sidebar's page panels: Outline (the headings; a click scrolls there; the one in view is marked),
// Backlinks (the pages linking here, each with the line around its link), Unlinked mentions (pages naming this one
// without a link: one click links a mention, or all of them) and Properties (compact). Each follows the open page.
import { headingsOf, renderInline } from "../../shared/markdown.js";
import { el, icon } from "../app/dom.js";
import { findMentions, linkContexts, linkMentions } from "./lines.js";
import { propertiesEditor } from "./props.js";
import { renderOptions } from "./render.js";
import { active, bus, safe, typeIcon } from "./util.js";

const empty = (text) => el("p", { class: "layr-muted side-empty" }, text);

/** Draw now, again when the page view draws (bus `events`); the shell calls `update` on route and data changes. */
const drawWith = (draw) => (root, app) => {
  root.classList.add("page-side");
  try {
    draw(root, app, app.page?.() ?? null);
  } catch (error) {
    root.replaceChildren(el("p", { class: "layr-error" }, error.message));
  }
};

function follow(draw, events = []) {
  const redraw = drawWith(draw);
  return (root, app) => {
    redraw(root, app);
    const listeners = events.map((type) => {
      const fn = () => redraw(root, app);
      bus.addEventListener(type, fn);
      return () => bus.removeEventListener(type, fn);
    });
    return () => listeners.forEach((off) => safe(off));
  };
}

// ---------- outline ----------

function drawOutline(root, app, page) {
  if (!page) return root.replaceChildren(empty("Open a page to see its headings."));
  const heads = headingsOf(page.body);
  if (!heads.length) return root.replaceChildren(empty("This page has no headings."));
  const min = Math.min(...heads.map((h) => h.level));
  const list = el("ul", { class: "outline" }, ...heads.map((h) => el("li", { class: "outline-item",
    style: { paddingLeft: `${(h.level - min) * 14 + 6}px` }, "data-id": h.id, "data-level": String(h.level) },
  el("button", { class: "outline-link", title: h.text, onclick: () => {
    if (active.view?.id === page.id) active.view.scrollToHeading(h.id);
    else app.openPage(page.id, { heading: h.id });
  } }, h.text))));
  root.replaceChildren(list);
  markCurrent(root);
}

/** Mark the heading the reader is in: the last one above the top third of the view. */
function markCurrent(root) {
  const view = active.view;
  const items = [...root.querySelectorAll(".outline-item")];
  if (!view?.reading || !items.length) return items.forEach((li) => li.classList.remove("current"));
  const line = view.scroller.getBoundingClientRect().top + 80;
  let current = null;
  for (const h of view.reading.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")) {
    if (h.getBoundingClientRect().top <= line) current = h.id;
    else break;
  }
  current ??= items[0]?.dataset.id;
  for (const li of items) li.classList.toggle("current", li.dataset.id === current);
  root.querySelector(".outline-item.current")?.scrollIntoView?.({ block: "nearest" });
}

function outlinePanel(root, app) {
  const stop = follow(drawOutline, ["render", "mode"])(root, app);
  let frame = 0;
  const onScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => markCurrent(root));
  };
  bus.addEventListener("scroll", onScroll);
  return () => {
    stop();
    bus.removeEventListener("scroll", onScroll);
  };
}

// ---------- backlinks ----------

function drawBacklinks(root, app, page) {
  if (!page) return root.replaceChildren(empty("Open a page to see what links to it."));
  const back = app.wiki.backlinks(page.id);
  if (!back.length) return root.replaceChildren(empty("No page links here yet."));
  const names = [page.title, ...page.aliases];
  root.replaceChildren(el("div", { class: "side-count" }, `${back.length} page${back.length === 1 ? "" : "s"}`),
    ...back.map((p) => {
      const opts = renderOptions(app, { page: p });
      const contexts = linkContexts(p.markdown, names, 3);
      return el("div", { class: "side-item" },
        el("a", { class: "side-title", href: "#", "data-page": p.title }, typeIcon(app, p.type), el("span", {}, p.title)),
        ...contexts.map((c) => el("div", { class: "side-snippet", html: renderInline(trim(c.text), opts) })));
    }));
}

/** A long line cut to about 200 characters around its middle part. */
const trim = (text) => (text.length > 220 ? `${text.slice(0, 200)}…` : text).replace(/^\s*([-*+]|\d+[.)]|#+|>)\s+/, "");

// ---------- unlinked mentions ----------

function drawMentions(root, app, page) {
  if (!page) return root.replaceChildren(empty("Open a page to see where it is mentioned without a link."));
  const pages = safe(() => app.wiki.unlinkedMentions(page.id), []) ?? [];
  const names = [page.title, ...page.aliases];
  const rows = pages.map((p) => ({ page: p, found: findMentions(p.markdown, names) })).filter((r) => r.found.length);
  if (!rows.length) return root.replaceChildren(empty("No page mentions this one without a link."));
  const total = rows.reduce((n, r) => n + r.found.length, 0);
  const link = async (p, which) => {
    try {
      const fresh = app.wiki.pages.get(p.id) ?? p;
      const { markdown, count } = linkMentions(fresh.markdown, page.title, names, which);
      if (!count) return app.ui.notify("That mention isn't there any more", "error");
      await app.wiki.save(p.id, markdown, { by: "you", note: `linked to ${page.title}` });
      if (which === "all") app.ui.notify(`Linked ${count} mention${count === 1 ? "" : "s"} in ${p.title}`, "success");
    } catch (error) {
      app.ui.fail(error);
    }
  };
  const linkAll = async () => {
    for (const r of rows) await link(r.page, "all");
  };
  root.replaceChildren(
    el("div", { class: "side-count" }, `${total} mention${total === 1 ? "" : "s"} in ${rows.length} page` +
      `${rows.length === 1 ? "" : "s"}`,
    el("button", { class: "layr-button small", title: "Turn every mention into a link", onclick: linkAll }, "Link all")),
    ...rows.map(({ page: p, found }) => {
      const lines = p.markdown.replace(/\r\n?/g, "\n").split("\n");
      return el("div", { class: "side-item" },
        el("div", { class: "side-item-head" },
          el("a", { class: "side-title", href: "#", "data-page": p.title }, typeIcon(app, p.type), el("span", {}, p.title)),
          found.length > 1 ? el("button", { class: "layr-button ghost small", onclick: () => link(p, "all") },
            `Link ${found.length}`) : null),
        ...found.slice(0, 8).map((m, i) => {
          const line = lines[m.line] ?? "";
          const start = m.index - lines.slice(0, m.line).join("\n").length - (m.line ? 1 : 0);
          const from = Math.max(0, start - 70);
          const to = Math.min(line.length, start + m.length + 90);
          return el("div", { class: "mention" },
            el("span", { class: "side-snippet" }, from ? "…" : "", line.slice(from, start),
              el("mark", {}, line.slice(start, start + m.length)), line.slice(start + m.length, to),
              to < line.length ? "…" : ""),
            el("button", { class: "layr-button ghost small mention-link", title: `Turn this into [[${page.title}]]`,
              onclick: () => link(p, i) }, icon("link"), " Link"));
        }));
    }));
}

// ---------- properties ----------

function drawProps(root, app, page) {
  if (!page) return root.replaceChildren(empty("Open a page to see its properties."));
  root.replaceChildren(propertiesEditor(app, page, null, { compact: true }),
    el("button", { class: "layr-button ghost small side-more", onclick: () => {
      const props = document.querySelector(".page-props");
      props?.classList.remove("folded");
      props?.scrollIntoView({ block: "start", behavior: "smooth" });
      props?.querySelector(".prop-input, .prop-select")?.focus();
    } }, icon("pencil"), " Edit the properties"));
}

export function installSidebar(app) {
  const side = (spec) => safe(() => app.sidebar.register("right", spec));
  side({ id: "outline", title: "Outline", icon: "list-tree", order: 10, render: outlinePanel,
    update: drawWith(drawOutline) });
  side({ id: "backlinks", title: "Backlinks", icon: "link", order: 20, render: follow(drawBacklinks),
    update: drawWith(drawBacklinks) });
  side({ id: "unlinked", title: "Unlinked mentions", icon: "unlink", order: 30, render: follow(drawMentions),
    update: drawWith(drawMentions) });
  side({ id: "properties", title: "Properties", icon: "list", order: 40, render: follow(drawProps),
    update: drawWith(drawProps) });
}
