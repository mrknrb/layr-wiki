// `app.hoverPreview(anchor, title, {heading})`: a small card with the linked page drawn in it, next to the link. The
// shell calls it after the pointer rests on a link (and the editor may too); it stays while the pointer is on the
// link or the card, and goes on leaving both, Escape, scrolling the page, or a click elsewhere.
import { sectionOf } from "../../shared/markdown.js";
import { el, icon } from "../app/dom.js";
import { renderInto } from "./render.js";
import { typeIcon } from "./util.js";

let card = null;

function hide() {
  if (!card) return;
  card.cleanup();
  card.node.remove();
  card = null;
}

export function hoverPreview(app, anchor, title, { heading = null, delay = 0 } = {}) {
  if (!anchor?.isConnected || app.settings?.get?.("hoverPreview") === false) return;
  if (window.matchMedia?.("(hover: none)").matches) return;
  if (card?.anchor === anchor) return;
  const go = () => {
    if (!anchor.isConnected || (delay && !anchor.matches(":hover"))) return;
    show(app, anchor, title, heading ?? anchor.dataset?.heading ?? null);
  };
  if (delay) setTimeout(go, delay);
  else go();
}

function show(app, anchor, title, heading) {
  hide();
  const page = app.wiki.resolve(title);
  const node = el("div", { class: "wiki-hover", role: "tooltip" });
  if (!page) {
    node.append(el("div", { class: "hover-head missing" }, icon("file-plus"), el("span", {}, title)),
      el("p", { class: "hover-empty" }, "No page with this title yet: click the link to create it."));
  } else {
    const where = page.folder ? el("span", { class: "hover-folder" }, page.folder.replaceAll("/", " › ")) : null;
    const body = el("div", { class: "hover-body" });
    const text = heading ? sectionOf(page.body, heading)?.text ?? page.body : page.body;
    node.append(el("div", { class: "hover-head" }, typeIcon(app, page.type),
      el("a", { class: "hover-title", href: "#", "data-page": page.title, ...(heading ? { "data-heading": heading } : {}) },
        page.title), where), body);
    if (text.trim()) {
      // Embeds inside stay shallow, and PDFs stay links: a preview should be quick.
      renderInto(app, body, text, { page, depth: 2, tasks: false, pdf: false });
    } else body.append(el("p", { class: "hover-empty" }, "This page is empty."));
  }
  document.body.append(node);
  place(node, anchor);
  let timer = null;
  const leave = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!node.matches(":hover") && !anchor.matches(":hover")) hide();
    }, 180);
  };
  const enter = () => clearTimeout(timer);
  const onKey = (e) => e.key === "Escape" && hide();
  const onDown = (e) => !node.contains(e.target) && hide();
  const onScroll = (e) => !node.contains(e.target) && hide();
  anchor.addEventListener("pointerleave", leave);
  anchor.addEventListener("pointerenter", enter);
  node.addEventListener("pointerleave", leave);
  node.addEventListener("pointerenter", enter);
  node.addEventListener("click", (e) => e.target.closest("a[data-page]") && setTimeout(hide, 0));
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("scroll", onScroll, true);
  card = {
    anchor,
    node,
    cleanup() {
      clearTimeout(timer);
      anchor.removeEventListener("pointerleave", leave);
      anchor.removeEventListener("pointerenter", enter);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
    },
  };
  // The link may vanish (the view drew again): the card goes with it.
  const watch = setInterval(() => {
    if (!card || card.node !== node) return clearInterval(watch);
    if (!anchor.isConnected) {
      clearInterval(watch);
      hide();
    }
  }, 500);
}

/** Below the link, or above it when there is no room; inside the window. */
function place(node, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = Math.min(440, window.innerWidth - 16);
  node.style.width = `${w}px`;
  const h = Math.min(node.offsetHeight, 380);
  const below = window.innerHeight - r.bottom;
  const top = below >= h + 12 || below > r.top ? r.bottom + 6 : r.top - h - 6;
  node.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
}
