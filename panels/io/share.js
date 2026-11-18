// Public read-only links (docs/PLAN.md › Sharing). Supabase Storage serves HTML as plain text, so a public page is
// JSON in the public bucket `lf-wiki-shares` (`<user id>/<slug>.json`, supabase/migrations/lf_0005_wiki_shares.sql)
// and the link opens the static viewer (share/index.html, hosted by the user; the setting shareViewer holds its
// address) at `#<project ref>/<user id>/<slug>`. The slug is random, so only people with the link find it. Only the
// owner can write or delete their folder. Data `share/<page id>` = `{slug, url, at, title, updated}`.
import { el, icon } from "../app/dom.js";
import { keyOf } from "../../shared/links.js";
import {
  SHARE_MAX_BYTES, newSlug, projectRef, shareDoc, shareLink, shareRequest, standaloneHtml,
} from "./convert.js";
import { renderPages } from "./render.js";

const shares = new Map(); // page id → share record
let loaded = null;

export function loadShares() {
  loaded ??= layr.data.list({ prefix: "share/", limit: 1000 }).then((rows) => {
    for (const r of rows) if (r.value?.slug) shares.set(r.key.slice("share/".length), r.value);
  }).catch(() => {});
  return loaded;
}

export const shareOf = (pageId) => shares.get(pageId) ?? null;

async function session(app) {
  const s = await (app.files?.session?.() ?? layr.tools.run("supabase_session", {}, { plugin: "layr" }));
  if (!s?.accessToken) throw new Error("Sign in to layr to publish pages");
  const ref = projectRef(s.url);
  if (!ref) throw new Error("This layr's database address isn't a Supabase project address");
  return { ...s, ref };
}

const storage = (s, method, slug, body = null) => shareRequest(s, method, slug, body);

/** No viewer address yet: what to do (README › Public links). */
function explainViewer(app) {
  app.ui.modal("Public links need your viewer page", (body, close) => {
    body.classList.add("io-dialog");
    body.append(
      el("p", {}, "A public link opens a small viewer page that you host once, for free, for example on GitHub Pages. " +
        "It shows the pages you publish to anyone with their link; nothing else of your wiki is public."),
      el("ol", { class: "io-steps" },
        el("li", {}, "Copy the file ", el("code", {}, "share/index.html"), " of the wiki plugin into a new GitHub " +
          "repository and turn on GitHub Pages (the wiki's README has the exact commands)."),
        el("li", {}, "Put the page's address (like ", el("code", {}, "https://you.github.io/wiki-share/"),
          ") in the wiki's Settings › Sharing › Address of your share viewer."),
        el("li", {}, "Publish from a page's ⋯ menu.")),
      el("div", { class: "ai-modal-buttons" },
        el("button", { class: "layr-button ghost", onclick: close }, "Close"),
        el("button", { class: "layr-button primary", onclick: () => {
          close();
          app.open({ view: "settings", group: "sharing" });
        } }, icon("settings"), "Open Sharing settings")));
  });
}

/** Publish a page, or update its public copy. Gives the share record. */
export async function publish(app, page, { quiet = false } = {}) {
  const viewer = String(app.settings?.get?.("shareViewer") ?? "").trim();
  if (!viewer) {
    explainViewer(app);
    return null;
  }
  await loadShares();
  const s = await session(app);
  const existing = shareOf(page.id);
  const slug = existing?.slug ?? newSlug();
  const { rendered, images } = await renderPages(app, [page]);
  // Links to pages that are public too go to their public link; other links are plain text.
  const anchors = new Map();
  for (const [id, sh] of shares) {
    const p = app.wiki.pages?.get(id);
    if (p && id !== page.id && sh.url) anchors.set(keyOf(p.title), sh.url);
  }
  const html = standaloneHtml(rendered[0].propsHtml + rendered[0].html, { anchors, images });
  const doc = shareDoc({ title: page.title, html, updated: page.updated, published: existing?.at ?? Date.now() });
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  if (bytes.length > SHARE_MAX_BYTES) throw new Error("The page is too big to publish (its pictures): at most 20 MB");
  await storage(s, "POST", slug, bytes);
  const record = { slug, url: shareLink(viewer, { ref: s.ref, uid: s.userId, slug }), at: existing?.at ?? Date.now(),
    title: page.title, updated: page.updated, published: Date.now() };
  await layr.data.set(`share/${page.id}`, record);
  shares.set(page.id, record);
  app.emit?.("shares", { id: page.id });
  app.emit?.("layout", { sidebar: "right" });
  if (!quiet) {
    await navigator.clipboard?.writeText(record.url).catch(() => {});
    app.ui.notify(existing ? "The public page is up to date (link copied)" : "Published: the link is copied", "success");
  }
  return record;
}

export async function unpublish(app, page) {
  await loadShares();
  const existing = shareOf(page.id);
  if (!existing) return;
  if (!(await app.ui.confirm(`Stop sharing “${page.title}”? Its public link stops working.`, { danger: true }))) return;
  const s = await session(app);
  await storage(s, "DELETE", existing.slug);
  await layr.data.delete(`share/${page.id}`);
  shares.delete(page.id);
  app.emit?.("shares", { id: page.id });
  app.emit?.("layout", { sidebar: "right" });
  app.ui.notify("The page is private again", "success");
}

const wrap = (app, fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (error) {
    app.ui.fail(error);
  }
};

/** The page's ⋯ menu entries for sharing. */
export function shareMenu(app, page) {
  const sh = shareOf(page.id);
  if (!sh) return [{ label: "Publish to the web…", icon: "public", run: wrap(app, () => publish(app, page)) }];
  const stale = (page.updated ?? 0) > (sh.updated ?? 0);
  return [{ label: stale ? "Public (changed since publishing)" : "Public", icon: "public", items: [
    { label: "Copy the public link", icon: "content_copy", run: () => navigator.clipboard.writeText(sh.url)
      .then(() => app.ui.notify("Link copied", "success"), () => app.ui.notify(sh.url, "info")) },
    { label: "Open the public page", icon: "open_in_new", run: () => layr.links.open(sh.url).catch(() => window.open(sh.url, "_blank")) },
    { label: "Update the public page", icon: "refresh", run: wrap(app, () => publish(app, page)) },
    "-",
    { label: "Stop sharing", icon: "public_off", run: wrap(app, () => unpublish(app, page)) },
  ] }];
}

/** The right sidebar's "Public" panel (shown while the open page is public): the link, copy, update, stop. */
export function renderSharePanel(app, root) {
  const draw = () => {
    const page = app.page?.();
    const sh = page ? shareOf(page.id) : null;
    if (!sh) return root.replaceChildren(el("p", { class: "layr-muted" }, "This page is private."));
    const stale = (page.updated ?? 0) > (sh.updated ?? 0);
    root.replaceChildren(el("div", { class: "io-share-panel" },
      el("div", { class: "io-share-badge" }, icon("globe"), "Public: anyone with the link can read it"),
      el("input", { class: "layr-input", readonly: true, value: sh.url, onfocus: (e) => e.target.select() }),
      stale ? el("p", { class: "io-share-stale" }, icon("triangle-alert"), "Changed since you published it.") : null,
      el("div", { class: "io-share-buttons" },
        el("button", { class: "layr-button small", onclick: () => navigator.clipboard.writeText(sh.url)
          .then(() => app.ui.notify("Link copied", "success")) }, icon("copy"), "Copy"),
        el("button", { class: `layr-button small${stale ? " primary" : ""}`, onclick: wrap(app, () => publish(app, page)) },
          icon("refresh-cw"), "Update"),
        el("button", { class: "layr-button small ghost", onclick: wrap(app, () => unpublish(app, page)) }, "Stop sharing"))));
  };
  draw();
  const offs = [app.on?.("shares", draw), app.on?.("changed", draw), app.on?.("route", draw)];
  return () => offs.forEach((off) => off?.());
}
