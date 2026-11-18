// The quick switcher (Ctrl+O: pages by title and alias) and the command palette (Ctrl+P: every command).
import { add, el, escapeHtml, icon, put } from "./dom.js";
import { keyLabel, rank } from "./pure.js";
import { tabIcon } from "./shell.js";
import { folders } from "./data.js";

/** Text with the matched letters bold. */
function marked(text, hits = []) {
  const set = new Set(hits);
  let out = "";
  [...String(text)].forEach((ch, i) => (out += set.has(i) ? `<b>${escapeHtml(ch)}</b>` : escapeHtml(ch)));
  return out;
}

/**
 * A list to pick from with a search box above it. `rows(query)` → `[{html|label, detail, icon, key, run(mods)}]`;
 * Enter picks (mods: {ctrl, shift}), arrows move, Escape closes.
 */
export function chooser({ placeholder, rows, hint, empty = "Nothing found", id = "chooser" }) {
  document.querySelector(".wiki-chooser-back")?.remove();
  const back = el("div", { class: "wiki-chooser-back wiki-modal-back", id });
  const input = el("input", { class: "wiki-chooser-input", placeholder, spellcheck: "false", autocomplete: "off",
    "aria-label": placeholder });
  const list = el("ul", { class: "wiki-chooser-list", role: "listbox" });
  const box = el("div", { class: "wiki-chooser", role: "dialog", "aria-label": placeholder },
    el("div", { class: "wiki-chooser-head" }, icon("search"), input), list,
    hint ? el("div", { class: "wiki-chooser-hint" }, ...hint.map(([k, t]) => el("span", {}, el("kbd",
      { class: "layr-kbd" }, k), ` ${t}`))) : null);
  add(back, box);
  let items = [];
  let at = 0;
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const draw = () => {
    items = rows(input.value);
    at = Math.min(at, Math.max(0, items.length - 1));
    put(list, ...(items.length ? items.map((r, i) => {
      const li = el("li", { class: `wiki-chooser-row${i === at ? " active" : ""}${r.create ? " create" : ""}`,
        role: "option",
        "aria-selected": String(i === at) },
      r.icon ? tabIcon(r.icon) : null,
      el("span", { class: "wiki-chooser-main" }, el("span", { class: "wiki-chooser-label",
        html: r.html ?? escapeHtml(r.label) }),
        r.detail ? el("span", { class: "wiki-chooser-detail" }, r.detail) : null),
      r.key ? el("kbd", { class: "layr-kbd" }, r.key) : null);
      li.addEventListener("mousemove", () => {
        if (at === i) return;
        at = i;
        mark();
      });
      li.addEventListener("click", (e) => pick(i, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
      return li;
    }) : [el("li", { class: "wiki-chooser-empty" }, empty)]));
  };
  const mark = () => [...list.children].forEach((li, i) => {
    li.classList.toggle("active", i === at);
    if (i === at) li.scrollIntoView({ block: "nearest" });
  });
  const pick = (i, mods) => {
    const r = items[i];
    if (!r) return;
    close();
    Promise.resolve().then(() => r.run(mods)).catch((e) => layr.ui.notify(e.message, "error").catch(() => {}));
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      at = Math.min(items.length - 1, at + 1);
      mark();
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey && items.length)) {
      at = Math.max(0, at - 1);
      mark();
    } else if (e.key === "Enter") pick(at, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  input.addEventListener("input", () => {
    at = 0;
    draw();
  });
  back.addEventListener("mousedown", (e) => e.target === back && close());
  document.addEventListener("keydown", onKey, true);
  add(document.body, back);
  draw();
  input.focus();
  return { close, input };
}

export function quickSwitcher(app) {
  const wiki = app.wiki;
  chooser({
    id: "switcher",
    placeholder: "Find or create a page…",
    hint: [["↵", "open"], ["Ctrl ↵", "new tab"], ["Shift ↵", "create"], ["Esc", "close"]],
    rows(query) {
      const q = query.trim();
      const pages = wiki.live();
      let rows;
      if (!q) {
        rows = pages.sort((a, b) => b.updated - a.updated).slice(0, 30).map((p) => ({ item: p, name: p.title,
          hits: [] }));
      } else {
        rows = rank(q, pages, (p) => [p.title, ...p.aliases,
          p.folder ? `${p.folder}/${p.title}` : null].filter(Boolean), 40);
      }
      const out = rows.map(({ item: p, name, hits }) => {
        const alias = name !== p.title && !name.endsWith(`/${p.title}`);
        return {
          icon: wiki.type?.(p.type)?.icon ?? "file-text",
          html: alias ? `${escapeHtml(p.title)} <span class="wiki-chooser-alias">${marked(name, hits)}</span>`
            : name === p.title ? marked(p.title, hits) : escapeHtml(p.title),
          detail: p.folder || "",
          run: (mods) => (mods.shift && q ? create(q, mods) : app.openPage(p.id, { newTab: mods.ctrl })),
        };
      });
      const exact = q && wiki.resolve(q);
      if (q && !exact) {
        out.push({ icon: "file-plus", create: true, html: `Create <b>${escapeHtml(q)}</b>`,
          detail: app.defaultFolder() || "",
          key: "Shift ↵", run: (mods) => create(q, mods) });
      }
      return out;
    },
  });
  async function create(title, mods) {
    const found = wiki.resolve(title);
    if (found) return app.openPage(found.id, { newTab: mods.ctrl });
    if (mods.ctrl) await app.open({ view: "home" }, { newTab: true });
    return app.newPage({ title, folder: app.defaultFolder() });
  }
}

export function commandPalette(app) {
  chooser({
    id: "palette",
    placeholder: "Type a command…",
    hint: [["↵", "run"], ["Esc", "close"]],
    rows(query) {
      const cmds = app.commands.list().filter((c) => c.title && !c.hidden);
      const recent = JSON.parse(localStorage.getItem("wiki.recentCommands") ?? "[]");
      const sorted = query.trim()
        ? rank(query, cmds, (c) => [c.title, c.id], 60)
        : cmds.sort((a, b) => {
          const ra = recent.indexOf(a.id);
          const rb = recent.indexOf(b.id);
          if (ra !== rb) return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb);
          return a.title.localeCompare(b.title);
        }).map((c) => ({ item: c, hits: [], name: c.title }));
      return sorted.map(({ item: c, hits, name }) => ({
        icon: c.icon ?? "terminal",
        html: name === c.title ? marked(c.title, hits) : escapeHtml(c.title),
        key: keyLabel(app.commands.key(c.id)),
        run: () => {
          const list = [c.id, ...recent.filter((id) => id !== c.id)].slice(0, 8);
          localStorage.setItem("wiki.recentCommands", JSON.stringify(list));
          return app.commands.run(c.id);
        },
      }));
    },
  });
}

/** Pick a folder (Move to…): gives the path ("" for the top), or null. */
export function pickFolder(app, { title = "Move to folder", except = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const all = ["", ...folders(app)].filter((f) => except === null || (f !== except && !f.startsWith(`${except}/`)));
    const c = chooser({
      id: "folderPicker",
      placeholder: title,
      hint: [["↵", "choose"], ["Esc", "cancel"]],
      rows(query) {
        const q = query.trim();
        const rows = q ? rank(q, all, (f) => [f || "/"], 60).map((r) => ({ f: r.item, hits: r.hits }))
          : all.map((f) => ({ f, hits: [] }));
        const out = rows.map(({ f, hits }) => ({ icon: f ? "folder" : "house", html: f ? marked(f,
          hits) : "Top folder (no folder)",
          run: () => finish(f) }));
        if (q && !all.some((f) => f.toLowerCase() === q.toLowerCase().replace(/^\/+|\/+$/g, ""))) {
          out.push({ icon: "folder-plus", create: true, html: `New folder <b>${escapeHtml(q)}</b>`,
            run: () => finish(q.replace(/^\/+|\/+$/g, "")) });
        }
        return out;
      },
    });
    // Closed without a choice: resolve null once the chooser is gone.
    const watch = setInterval(() => {
      if (!c.input.isConnected) {
        clearInterval(watch);
        setTimeout(() => finish(null), 0);
      }
    }, 150);
  });
}
