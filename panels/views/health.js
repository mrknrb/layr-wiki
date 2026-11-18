// The health page (route `health`): what needs care in the wiki, each with a one-click fix: broken links (create the
// page, or point the links at an existing one), pages nothing links to, duplicate titles and aliases, empty pages,
// and pages without a type in a folder where the others all have one.
import { keyOf, renameLinks } from "../../shared/links.js";
import { button, el, fail, icon, pageLink, typeIcon, watch } from "./common.js";

/** What the health page lists, from the wiki (pure but for the wiki's own methods). */
export function healthReport(wiki) {
  const live = wiki.live();
  const wanted = wiki.wanted();
  const orphans = wiki.orphans().filter((p) => !wiki.backlinks(p.id).length);
  const empty = live.filter((p) => !p.body.replace(/%%[\s\S]*?%%/g, "").trim());
  // Titles and aliases that name more than one page.
  const names = new Map();
  for (const p of live) {
    for (const n of [p.title, ...p.aliases]) {
      const k = keyOf(n);
      if (!names.has(k)) names.set(k, { name: n, pages: [] });
      const entry = names.get(k);
      if (!entry.pages.includes(p)) entry.pages.push(p);
    }
  }
  const duplicates = [...names.values()].filter((e) => e.pages.length > 1).sort((a, b) => a.name.localeCompare(b.name));
  // A page without a type among folder siblings that (at least 3, all of them) share one.
  const byFolder = new Map();
  for (const p of live) {
    const k = keyOf(p.folder ?? "");
    if (!k) continue;
    if (!byFolder.has(k)) byFolder.set(k, []);
    byFolder.get(k).push(p);
  }
  const untyped = [];
  for (const pages of byFolder.values()) {
    const typed = pages.filter((p) => p.type);
    const kinds = new Set(typed.map((p) => keyOf(p.type)));
    if (typed.length >= 3 && kinds.size === 1) {
      for (const p of pages) if (!p.type) untyped.push({ page: p, type: typed[0].type });
    }
  }
  return { wanted, orphans, empty, duplicates, untyped };
}

export function renderHealth(root, route, app) {
  const open = new Set(JSON.parse(sessionStorage.getItem("wiki.health.open") ?? '["wanted","duplicates","untyped"]'));
  const wrap = el("div", { class: "vw-page vw-health" });
  root.append(wrap);
  const act = (fn) => async () => {
    try {
      await fn();
    } catch (error) {
      fail(app, error);
    }
  };

  const createPage = (title) => act(async () => {
    if (app.newPage) return app.newPage({ title });
    const p = await app.wiki.create({ title });
    app.openPage(p.id);
  });

  /** Point every link to `from` at an existing page the user picks. */
  const retarget = (w) => act(async () => {
    const titles = app.wiki.live().map((p) => p.title).sort((a, b) => a.localeCompare(b));
    let picked = null;
    await new Promise((resolve) => app.ui.modal(`Link [[${w.title}]] to…`, (body, close) => {
      const id = "vw-health-titles";
      const input = el("input", { class: "layr-input", list: id, placeholder: "An existing page", autofocus: true });
      body.append(el("p", { class: "layr-muted" }, `${w.from.length} page${w.from.length > 1 ? "s link" : " links"} to “${w.title}”, ` +
        "which doesn't exist. Point the links at:"), input, el("datalist", { id }, titles.map((t) => el("option", { value: t }))));
      setTimeout(() => input.focus(), 30);
      return { ok: "Change links", focus: input, run: () => {
        const page = app.wiki.resolve(input.value);
        if (!page) throw new Error(`No page “${input.value}”`);
        picked = page;
        close();
      } };
    }, { onClose: resolve }));
    if (!picked) return;
    let n = 0;
    for (const p of w.from) {
      const fresh = app.wiki.pages.get(p.id);
      const { markdown, count } = renameLinks(fresh.markdown, w.title, picked.title);
      if (count) {
        await app.wiki.save(p.id, markdown, { note: `link fixed: ${w.title} → ${picked.title}` });
        n += count;
      }
    }
    app.ui.notify?.(`Changed ${n} link${n === 1 ? "" : "s"} to [[${picked.title}]]`);
  });

  const trash = (p) => act(async () => {
    if (!(await app.ui.confirm(`Move “${p.title}” to the trash?`))) return;
    await app.wiki.trash(p.id);
  });

  const addAlias = (p, name) => act(async () => {
    const t = await app.ui.prompt(`Rename “${p.title}”`, { value: p.title, label: `It shares “${name}” with another page` });
    if (t && t !== p.title) await app.wiki.rename(p.id, t);
  });

  const section = (id, ic, title, items, render, { hint = "", all = null } = {}) => {
    const isOpen = open.has(id) && items.length > 0;
    const details = el("details", { class: `vw-health-sec ${items.length ? "" : "ok"}`, open: isOpen || null },
      el("summary", {}, icon(items.length ? ic : "circle-check"), el("span", { class: "vw-health-title" }, title),
        el("span", { class: `vw-count ${items.length ? "warn" : ""}` }, String(items.length)), all),
      hint ? el("p", { class: "layr-muted vw-health-hint" }, hint) : null,
      el("ul", { class: "vw-health-list" }, items.slice(0, 300).map(render)),
      items.length > 300 ? el("p", { class: "layr-muted" }, `and ${items.length - 300} more`) : null);
    all?.addEventListener("click", (e) => e.preventDefault()); // a button in the summary doesn't fold it
    details.addEventListener("toggle", () => {
      if (details.open) open.add(id);
      else open.delete(id);
      sessionStorage.setItem("wiki.health.open", JSON.stringify([...open]));
    });
    return details;
  };

  const pageItem = (p, ...actions) => el("li", {}, typeIcon(app.wiki, p.type), pageLink(p),
    p.folder ? el("span", { class: "layr-muted vw-health-folder" }, p.folder) : null, el("span", { class: "layr-spacer" }), ...actions);

  const draw = () => {
    const r = healthReport(app.wiki);
    const issues = r.wanted.length + r.duplicates.length + r.empty.length + r.untyped.length;
    wrap.replaceChildren(
      el("header", { class: "vw-head" }, el("h1", { class: "vw-title" }, icon("health"), "Wiki health"),
        el("span", { class: "layr-muted" }, `${app.wiki.live().length} pages · ${issues ? `${issues} things to look at` : "all good"}`)),
      section("wanted", "link-2-off", "Broken links", r.wanted, (w) => el("li", {},
        icon("file-question", "vw-missing-ic"), el("b", { class: "vw-missing" }, w.title),
        el("span", { class: "layr-muted vw-health-from" }, "from ", w.from.slice(0, 4).map((p, i) => [i ? ", " : "", pageLink(p)]),
          w.from.length > 4 ? ` +${w.from.length - 4}` : ""),
        el("span", { class: "layr-spacer" }),
        button("file-plus", "Create", createPage(w.title)), button("link", "Link to…", retarget(w))),
      { hint: "Links to pages that don't exist yet. Create the page, or point the links at a page that has another name." }),
      section("duplicates", "copy", "Same title or alias", r.duplicates, (d) => el("li", { class: "vw-health-dup" },
        el("b", {}, d.name), el("span", { class: "vw-health-pages" }, d.pages.map((p) => el("span", { class: "vw-health-dup-page" },
          pageLink(p), button("pencil", "", addAlias(p, d.name), { title: `Rename ${p.title}` }))))),
      { hint: "Links to this name go to the oldest of these pages. Rename one, or merge them." }),
      section("empty", "file-minus", "Empty pages", r.empty, (p) => pageItem(p,
        button("pencil", "Write", () => app.openPage(p.id, { mode: "edit" })), button("trash-2", "", trash(p), { title: "Move to the trash" }))),
      section("untyped", "shapes", "Pages without a type", r.untyped, ({ page, type }) => pageItem(page,
        button(null, `Make it ${type}`, act(() => app.wiki.setProps(page.id, { type })))),
      { hint: "Every other page in their folder has the same type.",
        all: r.untyped.length > 1 ? button(null, "Fix all", act(async () => {
          for (const u of r.untyped) await app.wiki.setProps(u.page.id, { type: u.type });
        })) : null }),
      section("orphans", "unlink", "Pages nothing links to", r.orphans, (p) => pageItem(p,
        button("trash-2", "", trash(p), { title: "Move to the trash" })),
      { hint: "Not a problem by itself: link them from a related page so they are found again." }),
    );
  };
  draw();
  return watch(app, root, draw);
}
