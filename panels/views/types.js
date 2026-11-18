// The type editor (route `types` {name?}): the page types the user has made and the ones pages use without a
// definition; a type's name, icon, colour, description, fields (kind, options, link target; reordered by dragging)
// and the template its new pages start with. Saved through the model (defineType, renameType, deleteType).
import { keyOf } from "../../shared/links.js";
import { inferKind } from "../../shared/query.js";
import { button, draggable, el, fail, icon, PALETTE, popover, typeIcon, typesInUse, watch } from "./common.js";

const KINDS = [
  ["text", "Text"], ["number", "Number"], ["date", "Date"], ["checkbox", "Checkbox"], ["select", "Select"],
  ["multiselect", "Multi-select"], ["link", "Page link"], ["url", "URL"], ["file", "File"],
];
const EMOJIS = ("📄 📝 📚 📖 🗒️ 📌 📎 🔖 🏷️ 💡 ⭐ ❤️ ✅ ❓ ⚠️ 🔥 🎯 🚀 🧭 🗂️ 📁 🗃️ 📦 🧩 🛠️ ⚙️ 🔧 🧪 🔬 🧬 🦠 🌱 🌍 🗺️ " +
  "🏠 🏢 🏫 🏛️ 👤 👥 🧑‍🔬 🧑‍💻 🎓 💼 📅 🗓️ ⏰ ⌛ 📈 📊 💰 🧾 🛒 🍽️ 🎬 🎵 🎮 📷 🎨 ✈️ 🚗 ⚽ 🏃 🧘 💊 🩺 🐾 🌸 🌙 ☀️ " +
  "🔒 🔑 💬 📣 📰 🧠 🤖 💻 📱 🖥️ 🔗 🧷").split(" ");
const LUCIDE = ["file-text", "book", "book-open", "notebook", "lightbulb", "star", "flag", "folder", "user", "users",
  "calendar", "check-square", "flask-conical", "microscope", "dna", "graduation-cap", "briefcase", "building",
  "map-pin", "globe", "link", "image", "film", "music", "code", "bug", "rocket", "target", "heart", "tag"];
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** A field key from a label: "Due date" → "due_date". */
export const keyFromLabel = (label) => String(label ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40);

/** Fields guessed from the properties pages of a type hold (for "Define this type"). */
export function guessFields(pages) {
  const values = new Map();
  for (const p of pages) {
    for (const [k, v] of Object.entries(p.props ?? {})) {
      if (["type", "tags", "aliases"].includes(k) || !FIELD_KEY.test(k)) continue;
      if (!values.has(k)) values.set(k, []);
      values.get(k).push(v);
    }
  }
  return [...values].map(([key, vs]) => ({ key, label: key.replace(/_/g, " "), kind: inferKind(vs) }));
}

export function renderTypes(root, route, app) {
  let current = route.name ?? null;
  let draft = null; // the edited copy of the selected type
  let dirty = false;
  const wrap = el("div", { class: "vw-page vw-types" });
  root.append(wrap);

  const pagesOf = (name) => app.wiki.live().filter((p) => keyOf(p.type) === keyOf(name));
  const select = async (name) => {
    if (dirty && !(await app.ui.confirm("Leave this type without saving your changes?", { ok: "Leave" }))) return;
    current = name;
    draft = null;
    dirty = false;
    app.updateRoute?.({ name: name ?? null });
    draw();
  };

  const startDraft = () => {
    const t = current ? app.wiki.type?.(current) : null;
    draft = t ? { ...t, fields: (t.fields ?? []).map((f) => ({ ...f, _keyed: true })), original: t.name }
      : { name: current, icon: "", color: "", description: "", fields: [], template: "", original: null };
  };

  const newType = async () => {
    const name = await app.ui.prompt("New page type", { placeholder: "Book, Person, Meeting…", label: "Name", ok: "Create",
      check: (v) => (!v ? null : /^[\p{L}][\p{L}\p{N} _-]{0,39}$/u.test(v) ? (typesInUse(app.wiki).some((t) => keyOf(t.name) === keyOf(v))
        ? "There is a type of that name" : null) : "A letter, then letters, digits, spaces, _ or -") });
    if (!name) return;
    try {
      await app.wiki.defineType({ name, icon: "file-text", color: PALETTE[typesInUse(app.wiki).length % PALETTE.length],
        fields: [], template: "" });
      dirty = false;
      select(name);
    } catch (error) {
      fail(app, error);
    }
  };

  const save = async () => {
    const d = draft;
    try {
      const fields = d.fields.map(({ _keyed, ...f }) => {
        const out = { key: f.key, label: f.label, kind: f.kind };
        if (f.kind === "select" || f.kind === "multiselect") out.options = f.options ?? [];
        if (f.kind === "link") {
          if (f.target) out.target = f.target;
          if (f.multiple) out.multiple = true;
        }
        if (f.url && f.kind === "text") out.url = f.url;
        return out;
      });
      let name = d.name.trim();
      if (d.original && d.original !== name) {
        const n = pagesOf(d.original).length;
        if (n && !(await app.ui.confirm(`Rename the type “${d.original}” to “${name}”? ${n} page${n > 1 ? "s" : ""} will say ` +
          `type: ${name}.`, { ok: "Rename" }))) return;
        if (!app.wiki.renameType) throw new Error("Renaming types needs the newer wiki");
        const r = await app.wiki.renameType(d.original, name);
        name = r?.type?.name ?? name;
      }
      await app.wiki.defineType({ name, icon: d.icon || "file-text", color: d.color || "", description: d.description || "",
        fields, template: d.template ?? "" });
      dirty = false;
      current = name;
      draft = null;
      app.updateRoute?.({ name });
      app.ui.notify?.(`Saved the type ${name}`);
      draw();
    } catch (error) {
      fail(app, error);
    }
  };

  const remove = async () => {
    const n = pagesOf(current).length;
    if (!(await app.ui.confirm(`Delete the type “${current}”?`, { danger: true, ok: "Delete",
      detail: n ? `Its ${n} page${n > 1 ? "s keep" : " keeps"} “type: ${current}” and show it without a definition.` : "" }))) return;
    try {
      if (!app.wiki.deleteType) throw new Error("Deleting types needs the newer wiki");
      await app.wiki.deleteType(current);
      dirty = false;
      select(null);
    } catch (error) {
      fail(app, error);
    }
  };

  const define = async (name) => {
    try {
      await app.wiki.defineType({ name, icon: "file-text", color: PALETTE[typesInUse(app.wiki).length % PALETTE.length],
        fields: guessFields(pagesOf(name)), template: "" });
      draft = null;
      draw();
    } catch (error) {
      fail(app, error);
    }
  };

  const touch = () => {
    dirty = true;
    wrap.querySelector(".vw-type-save")?.removeAttribute("disabled");
    wrap.querySelector(".vw-type-dirty")?.removeAttribute("hidden");
  };

  // ---------- the list ----------

  const list = () => {
    const types = typesInUse(app.wiki);
    return el("aside", { class: "vw-types-list" },
      el("div", { class: "vw-types-list-head" }, el("b", {}, "Types"), el("span", { class: "layr-spacer" }),
        button("plus", "New", newType, { cls: "primary" })),
      types.length ? el("ul", { class: "layr-list" }, types.map((t) => el("li", {
        class: keyOf(t.name) === keyOf(current) ? "active" : "", tabindex: "0", onclick: () => select(t.name),
        onkeydown: (e) => e.key === "Enter" && select(t.name) },
      typeIcon(app.wiki, t.name), el("span", { class: "vw-grow" }, t.name),
      t.defined ? null : el("span", { class: "layr-badge warning", title: "Used by pages but not defined" }, "undefined"),
      el("span", { class: "layr-muted vw-types-n" }, String(t.count)))))
        : el("div", { class: "layr-empty vw-empty" }, el("p", {}, "No page types yet."),
          el("p", { class: "layr-muted" }, "A type gives its pages fields (an info box), an icon, a colour and a starting template.")));
  };

  // ---------- the editor ----------

  const editor = () => {
    if (!current) {
      return el("section", { class: "vw-type-edit vw-type-none" }, el("div", { class: "layr-empty vw-empty" }, icon("shapes", "big"),
        el("p", {}, "Pick a type to edit, or make a new one."), button("plus", "New type", newType, { cls: "primary" })));
    }
    const defined = app.wiki.type?.(current);
    const count = pagesOf(current).length;
    const tableBtn = button("table", `${count} page${count === 1 ? "" : "s"} · Open as a table`,
      () => app.savedViews.createFor({ type: current }), { title: "All pages of this type as a table" });
    if (!defined) {
      return el("section", { class: "vw-type-edit" }, el("h2", { class: "vw-type-h" }, typeIcon(app.wiki, current, "big"), current),
        el("div", { class: "vw-callout" }, el("p", {}, `${count} page${count === 1 ? " says" : "s say"} type: ${current}, but the type has ` +
          "no definition yet. Define it to give its pages fields, an icon and a template."),
        el("div", { class: "vw-pop-actions" }, button("check", "Define this type", () => define(current), { cls: "primary" }), tableBtn)));
    }
    if (!draft || keyOf(draft.original ?? "") !== keyOf(current)) startDraft();
    const d = draft;
    const iconBtn = el("button", { type: "button", class: "vw-icon-pick", title: "Icon",
      onclick: (e) => iconPopover(e.currentTarget) }, iconPreview(d.icon, d.color));
    const iconPopover = (anchor) => popover(anchor, (pop, close) => {
      const set = (v) => {
        d.icon = v;
        iconBtn.replaceChildren(iconPreview(d.icon, d.color));
        touch();
        close();
      };
      pop.append(el("div", { class: "vw-pop-title" }, "Emoji"),
        el("div", { class: "vw-emoji-grid" }, EMOJIS.filter(Boolean).map((e) => el("button", { type: "button", onclick: () => set(e) }, e))),
        el("div", { class: "vw-pop-title" }, "Icon"),
        el("div", { class: "vw-emoji-grid" }, LUCIDE.map((n) => el("button", { type: "button", title: n, onclick: () => set(n) }, icon(n)))),
        el("label", { class: "vw-field" }, el("span", {}, "Or type an emoji or a Lucide icon name"),
          el("input", { class: "layr-input", value: d.icon ?? "", onkeydown: (e) => e.key === "Enter" && set(e.target.value.trim()) })));
    }, { cls: "wide" });
    const name = el("input", { class: "layr-input vw-type-name", value: d.name, "aria-label": "Name",
      oninput: (e) => { d.name = e.target.value; touch(); } });
    const colors = el("div", { class: "vw-swatches" }, ["", ...PALETTE].map((c) => el("button", { type: "button",
      class: `vw-swatch ${(d.color || "") === c ? "on" : ""} ${c ? "" : "none"}`, style: c ? { background: c } : {},
      title: c || "No colour", onclick: (e) => {
        d.color = c;
        for (const b of colors.children) b.classList.toggle("on", b === e.currentTarget);
        iconBtn.replaceChildren(iconPreview(d.icon, d.color));
        touch();
      } })), el("input", { type: "color", class: "vw-color-input", title: "Another colour",
      value: /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : "#888888", oninput: (e) => {
        d.color = e.target.value;
        for (const b of colors.querySelectorAll(".vw-swatch")) b.classList.remove("on");
        iconBtn.replaceChildren(iconPreview(d.icon, d.color));
        touch();
      } }));
    const fieldsEl = el("div", { class: "vw-tfields" });
    const drawFields = () => {
      fieldsEl.replaceChildren(...d.fields.map((f, i) => fieldRow(f, i)));
      if (!d.fields.length) fieldsEl.append(el("p", { class: "layr-muted vw-pop-note" }, "No fields yet: its pages show their properties as they are."));
    };
    const fieldRow = (f, i) => {
      const types = typesInUse(app.wiki).filter((t) => t.defined).map((t) => t.name);
      const keyInput = el("input", { class: "layr-input vw-tf-key", value: f.key, title: "The property's key in the page",
        placeholder: "key", oninput: (e) => { f.key = e.target.value.trim(); f._keyed = true; touch(); } });
      const handle = el("span", { class: "vw-tf-handle", title: "Drag to reorder" }, icon("grip-vertical"));
      const row = el("div", { class: "vw-tfield", "data-i": String(i) }, handle,
        el("input", { class: "layr-input vw-tf-label", value: f.label ?? "", placeholder: "Label", "aria-label": "Label",
          oninput: (e) => {
            f.label = e.target.value;
            if (!f._keyed) {
              f.key = keyFromLabel(f.label);
              keyInput.value = f.key;
            }
            touch();
          } }),
        keyInput,
        el("select", { class: "layr-select vw-tf-kind", "aria-label": "Kind", onchange: (e) => { f.kind = e.target.value; touch(); drawFields(); } },
          KINDS.map(([v, l]) => el("option", { value: v, selected: v === f.kind }, l))),
        button("x", "", () => { d.fields.splice(i, 1); touch(); drawFields(); }, { title: "Remove the field" }),
        f.kind === "select" || f.kind === "multiselect" ? el("input", { class: "layr-input vw-tf-extra", value: (f.options ?? []).join(", "),
          placeholder: "Options, separated by commas", oninput: (e) => {
            f.options = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
            touch();
          } }) : null,
        f.kind === "link" ? el("div", { class: "vw-tf-extra vw-tf-link" },
          el("select", { class: "layr-select", onchange: (e) => { f.target = e.target.value || null; touch(); } },
            el("option", { value: "" }, "Pages of any type"), types.map((t) => el("option", { value: t, selected: keyOf(t) === keyOf(f.target ?? "") }, `${t} pages`))),
          el("label", { class: "vw-check-row" }, el("input", { type: "checkbox", checked: Boolean(f.multiple),
            onchange: (e) => { f.multiple = e.target.checked; touch(); } }), el("span", {}, "Several"))) : null,
        f.kind === "text" ? el("input", { class: "layr-input vw-tf-extra", value: f.url ?? "", placeholder: "Link pattern (optional): https://doi.org/{}",
          oninput: (e) => { f.url = e.target.value.trim(); touch(); } }) : null);
      draggable(row, { targets: ".vw-tfield", handle, drop: (target) => {
        const to = Number(target.dataset.i);
        if (to === i) return;
        const [moved] = d.fields.splice(i, 1);
        d.fields.splice(to, 0, moved);
        touch();
        drawFields();
      } });
      return row;
    };
    drawFields();
    const template = el("textarea", { class: "layr-textarea vw-type-template", rows: "8", spellcheck: "false",
      placeholder: "## Summary\n\n## Notes\n", oninput: (e) => { d.template = e.target.value; touch(); } });
    template.value = d.template ?? "";
    return el("section", { class: "vw-type-edit" },
      el("div", { class: "vw-type-top" }, iconBtn, name, el("span", { class: "vw-type-dirty layr-muted", hidden: !dirty || null }, "Unsaved")),
      el("div", { class: "vw-type-actions" }, tableBtn, el("span", { class: "layr-spacer" }),
        button("trash-2", "Delete type", remove, { cls: "danger ghost" })),
      el("label", { class: "vw-field" }, el("span", {}, "Colour"), colors),
      el("label", { class: "vw-field" }, el("span", {}, "Description"), el("input", { class: "layr-input", value: d.description ?? "",
        placeholder: "What pages of this type are about", oninput: (e) => { d.description = e.target.value; touch(); } })),
      el("div", { class: "vw-field" }, el("span", {}, "Fields"), fieldsEl,
        el("div", {}, button("plus", "Add field", () => {
          d.fields.push({ key: "", label: "", kind: "text", _keyed: false });
          touch();
          drawFields();
          fieldsEl.querySelector(".vw-tfield:last-child .vw-tf-label")?.focus();
        }))),
      el("label", { class: "vw-field" }, el("span", {}, "Template: the text new pages of this type start with"), template,
        el("small", { class: "layr-muted" }, "{{title}}, {{date}}, {{time}} and {{date:YYYY-MM-DD}} are filled in.")),
      el("div", { class: "vw-type-foot" },
        el("button", { class: "layr-button", type: "button", onclick: () => { draft = null; dirty = false; draw(); } }, "Revert"),
        el("button", { class: "layr-button primary vw-type-save", type: "button", disabled: !dirty || null, onclick: save }, "Save")));
  };

  const iconPreview = (ic, color) => {
    const v = ic || "file-text";
    if (/^[a-z0-9-]+$/.test(v)) {
      const s = icon(v);
      if (color) s.style.color = color;
      return s;
    }
    return el("span", { class: "vw-emoji" }, v);
  };

  const draw = () => {
    wrap.classList.toggle("has-current", Boolean(current));
    wrap.replaceChildren(
      el("header", { class: "vw-head" },
        current && app.ui.narrow?.() ? button("arrow-left", "", () => select(null), { title: "All types" }) : null,
        el("h1", { class: "vw-title" }, icon("shapes"), "Page types")),
      el("div", { class: "vw-types-body" }, list(), editor()));
  };
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && dirty && draft) {
      e.preventDefault();
      save();
    }
  };
  root.addEventListener("keydown", onKey);
  draw();
  const unwatch = watch(app, root, () => !dirty && draw(), { filter: (d) => d.types || d.ids?.length });
  return () => {
    unwatch();
    root.removeEventListener("keydown", onKey);
  };
}
