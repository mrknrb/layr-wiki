// Small DOM helpers every part of the panel uses.
export { escapeHtml } from "../../shared/markdown.js";
import { ICONS } from "./icons.js";

export const $ = (id) => document.getElementById(id);

const kids = (list) => list.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
/** `node.replaceChildren(…)` that skips null, undefined and false (left out by `cond ? x : null`). */
export const put = (node, ...children) => node.replaceChildren(...kids(children));
/** `node.append(…)` that skips null, undefined and false. */
export const add = (node, ...children) => node.append(...kids(children));

/** `el("div", {class: "x", onclick: fn, html: "<b>raw</b>"}, child, "text", [more])`; null/false children skipped. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "style" && typeof v === "object") {
      // Custom properties (--depth) only work through setProperty.
      for (const [name, value] of Object.entries(v)) {
        if (name.startsWith("--")) node.style.setProperty(name, value);
        else node.style[name] = value;
      }
    }
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

/** A Lucide icon by its name (https://lucide.dev, ISC licence) as an inline SVG: `icon("search")`. */
export function icon(name, cls = "") {
  const span = el("span", { class: `icon ${cls}`.trim(), "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ` +
    `stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS["circle"] ?? ""}</svg>`;
  return span;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else the date. */
export function ago(ms) {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

export const narrow = () => window.matchMedia("(max-width: 700px)").matches;
export const debounce = (fn, ms) => {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
