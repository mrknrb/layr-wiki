// The attachments page (route `attachments`): every file the wiki holds, its size and kind, the pages that embed or
// link it, the ones nothing uses (flagged), picture thumbnails, open, upload. Names are content addresses in Storage,
// so files aren't renamed here; an unused file's record can be deleted when the Files store offers it.
import { keyOf } from "../../shared/links.js";
import { button, el, fail, fileUrl, icon, IMAGE, lazyImage, pageLink, watch } from "./common.js";

const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n ?? 0} B`);
const KIND_ICON = { image: "image", pdf: "file-text", table: "sheet", text: "file-text", other: "file" };
const kindOf = (r) => (IMAGE.test(r.name) ? "image" : /\.pdf$/i.test(r.name) ? "pdf"
  : /\.(csv|tsv|xlsx?)$/i.test(r.name) ? "table" : /^text\//.test(r.mime ?? "") ? "text" : "other");

/** Attachment name (lowercase) → the live pages that embed or link it. */
export function fileUses(wiki) {
  const uses = new Map();
  for (const p of wiki.live()) {
    for (const f of p.files ?? []) {
      const k = keyOf(f);
      if (!uses.has(k)) uses.set(k, []);
      uses.get(k).push(p);
    }
  }
  return uses;
}

export function renderAttachments(root, route, app) {
  const state = { filter: route.filter ?? "all", q: "", sort: "name" };
  let records = null;
  let error = null;
  const wrap = el("div", { class: "vw-page vw-files" });
  root.append(wrap);
  const remove = app.files?.remove ?? app.files?.delete;

  const load = async () => {
    try {
      records = await app.files.list();
      error = null;
    } catch (e) {
      error = e;
      records = [];
    }
    draw();
  };

  const upload = () => {
    const input = el("input", { type: "file", multiple: true, style: { display: "none" } });
    input.addEventListener("change", async () => {
      const list = [...input.files];
      input.remove();
      let n = 0;
      for (const f of list) {
        try {
          await app.files.upload(f.name, new Uint8Array(await f.arrayBuffer()), f.type || null);
          n++;
        } catch (e) {
          fail(app, e);
        }
      }
      if (n) app.ui.notify?.(`Uploaded ${n} file${n > 1 ? "s" : ""}. Embed one in a page as ![[name]].`);
      load();
    });
    document.body.append(input);
    input.click();
  };

  const preview = async (r) => {
    const url = await fileUrl(app, r.name);
    if (!url) return fail(app, new Error(`Couldn't load ${r.name}`));
    app.ui.modal(r.name, (body) => {
      const kind = kindOf(r);
      body.classList.add("vw-preview");
      if (kind === "image") body.append(el("img", { src: url, alt: r.name }));
      else if (kind === "pdf") body.append(el("iframe", { src: url, title: r.name }));
      else body.append(el("p", { class: "layr-muted" }, `${r.mime || "A file"}, ${size(r.size)}.`));
      body.append(el("div", { class: "vw-pop-actions" }, el("a", { class: "layr-button", href: url, download: r.name },
        icon("download"), el("span", {}, "Download")), el("button", { class: "layr-button", type: "button",
        onclick: () => navigator.clipboard?.writeText(`![[${r.name}]]`).then(() => app.ui.notify?.("Copied the embed")) },
      icon("copy"), el("span", {}, "Copy embed"))));
      return { wide: true };
    });
  };

  const del = async (r) => {
    if (!(await app.ui.confirm(`Delete “${r.name}”? No page uses it.`, { danger: true }))) return;
    try {
      await remove.call(app.files, r.name);
      load();
    } catch (e) {
      fail(app, e);
    }
  };

  const draw = () => {
    const uses = fileUses(app.wiki);
    const head = el("header", { class: "vw-head" }, el("h1", { class: "vw-title" }, icon("paperclip"), "Attachments"),
      el("span", { class: "layr-spacer" }), button("upload", "Upload", upload, { cls: "primary" }));
    if (!records) {
      wrap.replaceChildren(head, el("div", { class: "layr-empty vw-empty" }, el("span", { class: "layr-spinner" })));
      return;
    }
    const known = new Set(records.map((r) => keyOf(r.name)));
    // Embeds of files that aren't uploaded (yet, or on this device): listed too, so broken embeds show.
    const missing = [...uses.keys()].filter((k) => !known.has(k)).map((k) => ({ name: uses.get(k)[0].files.find((f) => keyOf(f) === k),
      missing: true, size: 0 }));
    let items = [...records, ...missing].map((r) => ({ ...r, uses: uses.get(keyOf(r.name)) ?? [] }));
    const unused = items.filter((r) => !r.uses.length && !r.missing);
    const total = records.reduce((s, r) => s + (r.size ?? 0), 0);
    if (state.filter === "unused") items = items.filter((r) => !r.uses.length && !r.missing);
    else if (state.filter === "missing") items = items.filter((r) => r.missing);
    else if (state.filter !== "all") items = items.filter((r) => kindOf(r) === state.filter);
    const q = keyOf(state.q);
    if (q) items = items.filter((r) => keyOf(r.name).includes(q));
    items.sort(state.sort === "size" ? (a, b) => (b.size ?? 0) - (a.size ?? 0) : state.sort === "date"
      ? (a, b) => (b.at ?? 0) - (a.at ?? 0) : (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const chip = (v, label, n) => el("button", { type: "button", class: state.filter === v ? "active" : "",
      onclick: () => { state.filter = v; app.updateRoute?.({ filter: v === "all" ? null : v }); draw(); } },
    label, n !== undefined ? el("span", { class: "vw-count" }, String(n)) : null);
    const bar = el("div", { class: "vw-bar" },
      el("div", { class: "vw-seg small" }, chip("all", "All", records.length), chip("image", "Pictures"), chip("pdf", "PDFs"),
        chip("unused", "Unused", unused.length), missing.length ? chip("missing", "Not uploaded", missing.length) : null),
      el("select", { class: "layr-select vw-sort-sel", onchange: (e) => { state.sort = e.target.value; draw(); } },
        [["name", "A to Z"], ["date", "Newest"], ["size", "Largest"]].map(([v, l]) => el("option", { value: v, selected: v === state.sort }, l))),
      el("input", { class: "layr-input vw-grow", type: "search", placeholder: "Find a file", value: state.q,
        oninput: (e) => { state.q = e.target.value; drawGrid(); } }));
    const summary = el("p", { class: "layr-muted vw-sub" }, `${records.length} files, ${size(total)}` +
      (unused.length ? ` · ${unused.length} not used by any page` : ""));
    const grid = el("div", { class: "vw-file-grid" });
    const drawGrid = () => {
      const qq = keyOf(state.q);
      grid.replaceChildren(...items.filter((r) => !qq || keyOf(r.name).includes(qq)).map(card));
      if (!grid.children.length) {
        grid.append(el("div", { class: "layr-empty vw-empty" }, icon("paperclip", "big"),
          el("p", {}, records.length ? "No file matches." : "No attachments yet."),
          el("p", { class: "layr-muted" }, "Paste or drop a picture or a PDF into a page, or upload files here.")));
      }
    };
    const card = (r) => {
      const kind = kindOf(r);
      const thumb = el("div", { class: "vw-file-thumb" });
      if (kind === "image" && !r.missing) {
        const img = el("img", { alt: "", loading: "lazy" });
        thumb.append(img);
        lazyImage(app, img, r.name, () => thumb.replaceChildren(icon("image-off", "big")));
      } else thumb.append(icon(r.missing ? "file-x" : KIND_ICON[kind], "big"));
      const flags = r.missing ? el("span", { class: "layr-badge danger" }, "not uploaded")
        : !r.uses.length ? el("span", { class: "layr-badge warning" }, "unused") : null;
      return el("article", { class: `vw-file ${r.uses.length ? "" : "unused"} ${r.missing ? "missing" : ""}` },
        el("button", { type: "button", class: "vw-file-open", title: r.missing ? r.name : "Open", disabled: r.missing || null,
          onclick: () => preview(r) }, thumb),
        el("div", { class: "vw-file-info" },
          el("div", { class: "vw-file-name", title: r.name }, r.name),
          el("div", { class: "vw-file-meta layr-muted" }, r.missing ? "embedded but not in the store"
            : `${size(r.size)}${r.at ? ` · ${new Date(r.at).toLocaleDateString()}` : ""}`, flags),
          r.uses.length ? el("div", { class: "vw-file-uses" }, icon("link"), r.uses.slice(0, 3).map((p) => pageLink(p)),
            r.uses.length > 3 ? el("span", { class: "layr-muted" }, `+${r.uses.length - 3}`) : null) : null,
          !r.uses.length && !r.missing && remove ? el("div", { class: "vw-file-actions" },
            button("trash-2", "Delete", () => del(r), { cls: "danger" })) : null));
    };
    drawGrid();
    wrap.replaceChildren(head, summary, bar, ...(error ? [el("p", { class: "layr-error" }, error.message)] : []), grid);
  };

  draw();
  load();
  return watch(app, root, () => (records ? draw() : null), { filter: (d) => d.ids?.length || d.files });
}
