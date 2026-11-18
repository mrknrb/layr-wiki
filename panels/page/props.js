// The properties above a page's text, Obsidian style: one row per property, an input that fits its kind (text,
// number, date, checkbox, select, multiselect chips, link with page completion, url, file), add / remove / rename a
// property and change its kind. A type's fields always show (empty ones too), with the kinds the type gives them;
// other properties get a kind from their value. Every change writes only the lines of that property (setProperties).
import { asList, isFileTarget, keyOf, parseLink } from "../../shared/links.js";
import { renderInline } from "../../shared/markdown.js";
import { emptyValue, fieldValue, KINDS, parseFieldInput } from "../../shared/types.js";
import { el, icon } from "../app/dom.js";
import { renderOptions } from "./render.js";
import { safe, typeIcon } from "./util.js";

const KIND_ICONS = {
  text: "text", number: "hash", date: "calendar", checkbox: "square-check", select: "circle-chevron-down",
  multiselect: "list", link: "link", url: "globe", file: "paperclip", tags: "tags", aliases: "forward", type: "shapes",
};
const KIND_LABELS = {
  text: "Text", number: "Number", date: "Date", checkbox: "Checkbox", select: "Select", multiselect: "List",
  link: "Link to a page", url: "Web address", file: "Attachment",
};
const FOLD_KEY = "wiki.propsFolded";

/** The kind of a property no type describes, read from its value. */
export function inferKind(value) {
  if (Array.isArray(value)) {
    return value.length && value.every((v) => /^\s*\[\[[^\]]+\]\]\s*$/.test(String(v))) ? "link" : "multiselect";
  }
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  const s = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s)) return "date";
  const link = /^\s*!?\[\[([^\]]+)\]\]\s*$/.exec(s);
  if (link) return isFileTarget(parseLink(link[1]).target) ? "file" : "link";
  if (/^https?:\/\/\S+$/.test(s)) return "url";
  return "text";
}

/** The rows: `[{key, label, kind, field?, special?}]` in the page's order, then the type's missing fields. */
export function propertyRows(page, type) {
  const fields = type?.fields ?? [];
  const rows = [];
  const seen = new Set();
  const add = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const field = fields.find((f) => f.key === key);
    if (key === "type" || key === "tags" || key === "aliases") rows.push({ key, label: key, kind: key, special: true });
    else if (field) rows.push({ key, label: field.label ?? key, kind: field.kind ?? "text", field });
    else rows.push({ key, label: key, kind: inferKind(page.props[key]), field: null });
  };
  for (const key of Object.keys(page.props)) add(key);
  for (const f of fields) add(f.key);
  return rows;
}

/**
 * The properties editor of `page` in a fresh element. `write(changes)` saves `{key: value|null}`; `opts.compact`:
 * the sidebar's read-only list.
 */
export function propertiesEditor(app, page, write, { compact = false } = {}) {
  const type = page.type ? safe(() => app.wiki.type(page.type)) : null;
  const rows = propertyRows(page, type);
  if (compact) return compactList(app, page, rows);
  const folded = safe(() => localStorage.getItem(FOLD_KEY) === "1", false);
  const box = el("section", { class: `page-props${folded ? " folded" : ""}`, "aria-label": "Properties" });
  const head = el("button", { class: "page-props-head", "aria-expanded": String(!folded), onclick: () => {
    const now = !box.classList.toggle("folded");
    head.setAttribute("aria-expanded", String(now));
    safe(() => localStorage.setItem(FOLD_KEY, now ? "0" : "1"));
  } }, icon("chevron-down", "fold"), el("span", {}, "Properties"),
  el("span", { class: "page-props-count" }, rows.length ? String(rows.length) : ""));
  const list = el("div", { class: "page-props-list" });
  for (const row of rows) list.append(rowEditor(app, page, row, write));
  const adder = el("button", { class: "page-props-add", onclick: () => addProperty(app, page, list, adder, write) },
    icon("plus"), "Add property");
  box.append(head, el("div", { class: "page-props-body" }, list, adder));
  return box;
}

function compactList(app, page, rows) {
  const opts = renderOptions(app, { page });
  const shown = rows.filter((r) => !isEmpty(page.props[r.key]));
  if (!shown.length) return el("p", { class: "layr-muted side-empty" }, "No properties. Add them above the text.");
  return el("dl", { class: "props-compact" }, ...shown.flatMap((r) => [
    el("dt", {}, icon(KIND_ICONS[r.kind] ?? "text"), r.label),
    el("dd", { html: asList(page.props[r.key]).map((v) => renderInline(String(v), opts)).join(", ") }),
  ]));
}

const isEmpty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

function rowEditor(app, page, row, write) {
  const save = (value) => write({ [row.key]: value }).catch((e) => app.ui.fail(e));
  const label = el("button", { class: "prop-key", title: `${row.label} (${KIND_LABELS[row.kind] ?? row.kind})`,
    onclick: (e) => keyMenu(app, page, row, write, e) }, icon(KIND_ICONS[row.kind] ?? "text"),
  el("span", {}, row.label));
  const value = el("div", { class: "prop-value" });
  try {
    value.append(valueEditor(app, page, row, save, write));
  } catch (error) {
    value.append(el("span", { class: "layr-error" }, error.message));
  }
  return el("div", { class: "prop-row", "data-key": row.key, "data-kind": row.kind }, label, value);
}

/** The ⋯ of a property: its kind, rename, remove. */
function keyMenu(app, page, row, write, e) {
  const fromType = Boolean(row.field) || row.special;
  const value = page.props[row.key];
  app.ui.menu([
    ...(!fromType ? [{ label: "Kind", icon: "category", items: KINDS.map((k) => ({
      label: KIND_LABELS[k], checked: k === row.kind, run: () => write({ [row.key]: convert(value, row.kind, k) }),
    })) }, "-"] : []),
    row.field && page.type ? { label: `Field of the type ${page.type}`, icon: "info", disabled: true } : null,
    !fromType ? { label: "Rename…", icon: "edit", run: async () => {
      const name = await app.ui.prompt("Rename the property", { value: row.key, label: "Name", ok: "Rename",
        check: (v) => (!v ? "Give it a name" : /[:#\n]/.test(v) || /^\s|\s$/.test(v) ? "No : or # in a name" :
          v !== row.key && v in page.props ? "There is a property of that name" : null) });
      if (name && name !== row.key) await write({ [row.key]: null, [name]: value ?? "" });
    } } : null,
    { label: "Remove", icon: "delete", danger: true, disabled: !(row.key in page.props),
      run: () => write({ [row.key]: null }) },
  ].filter(Boolean), e).catch((err) => app.ui.fail(err));
}

/** A value from one kind to another, keeping what can be kept. */
export function convert(value, from, to) {
  const list = asList(value).map((s) => s.replace(/^\s*\[\[([^\]|]+)(\|[^\]]*)?\]\]\s*$/, "$1"));
  const first = list[0] ?? "";
  switch (to) {
    case "checkbox":
      return /^(true|yes|1|x|on)$/i.test(first);
    case "number": {
      const n = Number(first);
      return first !== "" && Number.isFinite(n) ? n : null;
    }
    case "multiselect":
      return list;
    case "link":
      return from === "multiselect" && list.length > 1 ? list.map((t) => `[[${t}]]`) : first ? `[[${first}]]` : "";
    case "file":
      return first ? `[[${first}]]` : "";
    case "date":
      return /^\d{4}-\d{2}-\d{2}/.test(first) ? first.slice(0, 10) : new Date().toISOString().slice(0, 10);
    default:
      return list.join(", ");
  }
}

/** A text input that saves on Enter or when it loses focus (only when its text changed). */
function textInput(value, save, attrs = {}) {
  const input = el("input", { class: "prop-input", value: value ?? "", spellcheck: "false", ...attrs });
  let last = input.value;
  const commit = () => {
    if (input.value === last) return;
    last = input.value;
    save(input.value);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      input.value = last;
      input.blur();
    }
  });
  return input;
}

let listId = 0;
function datalist(values) {
  const id = `wiki-dl-${++listId}`;
  return [id, el("datalist", { id }, ...[...new Set(values)].slice(0, 400).map((v) => el("option", { value: v })))];
}

function valueEditor(app, page, row, save, write) {
  const raw = page.props[row.key];
  const field = row.field ?? { key: row.key, kind: row.kind };
  const parse = (text) => {
    try {
      return parseFieldInput(row.kind, text, field);
    } catch (error) {
      app.ui.notify(error.message, "error");
      throw error;
    }
  };
  const store = (v) => save(v === "" ? null : v);
  switch (row.kind) {
    case "type":
      return typePicker(app, page, write);
    case "tags":
    case "aliases":
      return chips(app, asList(raw).map((s) => s.replace(/^#/, "")), (list) => save(list), {
        suggest: row.kind === "tags" ? allTags(app) : [], prefix: row.kind === "tags" ? "#" : "",
        placeholder: row.kind === "tags" ? "Add a tag" : "Add another name",
        tag: row.kind === "tags",
      });
    case "number":
      return textInput(raw ?? "", (v) => store(v.trim() === "" ? null : parse(v)), { type: "number", step: "any" });
    case "date": {
      const v = fieldValue(page, { ...field, kind: "date" }) ?? "";
      const timed = /T\d{2}:\d{2}/.test(v);
      return textInput(v, (x) => store(x ? parse(x) : null), { type: timed ? "datetime-local" : "date" });
    }
    case "checkbox": {
      const box = el("input", { type: "checkbox", class: "prop-check" });
      box.checked = fieldValue(page, { ...field, kind: "checkbox" });
      box.addEventListener("change", () => save(box.checked));
      return box;
    }
    case "select": {
      const current = raw === null || raw === undefined ? "" : String(raw);
      const options = [...new Set([...(field.options ?? []), ...(current ? [current] : [])])];
      const select = el("select", { class: "prop-select" }, el("option", { value: "" }, "—"),
        ...options.map((o) => el("option", { value: o, selected: o === current }, o)));
      select.addEventListener("change", () => store(select.value || null));
      return select;
    }
    case "multiselect":
      return chips(app, asList(raw), (list) => save(list), { suggest: [...(field.options ?? []), ...valuesOf(app, row.key)],
        placeholder: "Add" });
    case "link": {
      const multiple = Boolean(field.multiple) || Array.isArray(raw);
      const targets = asList(raw).map((v) => /^\s*\[\[([^\]]+)\]\]\s*$/.exec(v)?.[1] ?? v).map((v) => parseLink(v).target)
        .filter(Boolean);
      const pages = app.wiki.live().filter((p) => !field.target || keyOf(p.type) === keyOf(field.target));
      return chips(app, targets, (list) => save(multiple ? list.map((t) => `[[${t}]]`) : list[0] ? `[[${list[0]}]]` : null), {
        suggest: pages.map((p) => p.title), placeholder: multiple || !targets.length ? "Link a page" : "", link: true,
        single: !multiple,
      });
    }
    case "file": {
      const name = fieldValue(page, { ...field, kind: "file" });
      const names = Array.isArray(name) ? name : name ? [name] : [];
      const wrap = el("div", { class: "prop-file" });
      const [id, dl] = datalist([]);
      app.files?.list?.().then((list) => dl.replaceChildren(...list.map((f) => el("option", { value: f.name }))))
        .catch(() => {});
      wrap.append(...names.map((n) => el("a", { class: "att-link", href: "#", "data-file": n }, icon("paperclip"), ` ${n}`)),
        textInput("", (v) => v && save(`[[${v}]]`), { list: id, placeholder: names.length ? "Change…" : "Attachment name" }),
        dl,
        el("button", { class: "layr-button ghost icon small", title: "Upload a file", "aria-label": "Upload a file",
          onclick: () => pickFile(app).then((n) => n && save(`[[${n}]]`)).catch((e) => app.ui.fail(e)) }, icon("upload")));
      return wrap;
    }
    case "url": {
      const v = raw ?? "";
      const wrap = el("div", { class: "prop-url" }, textInput(v, (x) => store(x.trim() || null),
        { type: "url", placeholder: "https://" }));
      if (/^https?:\/\//.test(String(v))) {
        wrap.append(el("a", { class: "prop-open", href: String(v), target: "_blank", rel: "noopener noreferrer",
          title: "Open" }, icon("external-link")));
      }
      return wrap;
    }
    default: {
      const v = Array.isArray(raw) ? raw.join(", ") : raw ?? "";
      const wrap = el("div", { class: "prop-text" }, textInput(v, (x) => store(x.trim() || null)));
      // A field with a database pattern (https://doi.org/{}): a link to the value there.
      if (field.url && v) {
        wrap.append(el("a", { class: "prop-open", href: field.url.replace("{}", encodeURIComponent(String(v))),
          target: "_blank", rel: "noopener noreferrer", title: "Open in the database" }, icon("external-link")));
      } else if (/\[\[[^\]]+\]\]/.test(String(v))) {
        // Text holding links: the links stay clickable next to the box.
        wrap.append(el("span", { class: "prop-links", html: renderInline(String(v), renderOptions(app, { page })) }));
      }
      return wrap;
    }
  }
}

function typePicker(app, page, write) {
  const types = safe(() => app.wiki.types(), []) ?? [];
  const current = page.type ?? "";
  const names = [...new Set([...types.map((t) => t.name), ...(current ? [current] : [])])];
  const select = el("select", { class: "prop-select" }, el("option", { value: "" }, "No type"),
    ...names.map((n) => el("option", { value: n, selected: keyOf(n) === keyOf(current) }, n)));
  select.addEventListener("change", () => {
    const name = select.value || null;
    const changes = { type: name };
    // The new type's fields the page doesn't have yet start empty, so they show up to be filled in.
    for (const f of (name && safe(() => app.wiki.type(name))?.fields) || []) {
      if (!(f.key in page.props)) changes[f.key] = emptyValue(f) ?? "";
    }
    write(changes).catch((e) => app.ui.fail(e));
  });
  const wrap = el("div", { class: "prop-type" }, typeIcon(app, current || null), select);
  if (current && !safe(() => app.wiki.type(current))) {
    wrap.append(el("button", { class: "layr-button ghost small", title: "This type has no definition yet",
      onclick: () => app.open({ view: "types", name: current }) }, "Define"));
  }
  return wrap;
}

function allTags(app) {
  const set = new Set();
  for (const p of app.wiki.live()) for (const t of p.tags) set.add(t);
  return [...set].sort();
}

function valuesOf(app, key) {
  const set = new Set();
  for (const p of app.wiki.live()) for (const v of asList(p.props[key])) set.add(v);
  return [...set].sort();
}

/** Values as chips (× removes one) and a box to add more (Enter or comma), with suggestions. */
function chips(app, values, save, { suggest = [], placeholder = "Add", prefix = "", link = false, tag = false,
  single = false } = {}) {
  const wrap = el("div", { class: "prop-chips" });
  const [id, dl] = datalist(suggest.filter((s) => !values.includes(s)));
  const set = (list) => save([...new Set(list.map((s) => s.trim()).filter(Boolean))]);
  for (const v of values) {
    const text = link
      ? el("a", { class: `wl${app.wiki.resolve(v) ? "" : " missing"}`, href: "#", "data-page": v }, v)
      : tag ? el("a", { class: "tag", href: "#", "data-tag": v }, `${prefix}${v}`) : el("span", {}, v);
    wrap.append(el("span", { class: "prop-chip" }, text,
      el("button", { class: "prop-chip-x", title: `Remove ${v}`, "aria-label": `Remove ${v}`,
        onclick: () => set(values.filter((x) => x !== v)) }, icon("x"))));
  }
  if (!single || !values.length) {
    const input = el("input", { class: "prop-input chip-input", list: id, placeholder, spellcheck: "false" });
    const add = () => {
      const parts = input.value.split(",").map((s) => (prefix ? s.trim().replace(/^#/, "") : s.trim())).filter(Boolean);
      if (!parts.length) return;
      input.value = "";
      set(single ? parts.slice(0, 1) : [...values, ...parts]);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || (e.key === "," && !link)) {
        e.preventDefault();
        add();
      } else if (e.key === "Backspace" && !input.value && values.length && !single) {
        set(values.slice(0, -1));
      }
    });
    input.addEventListener("change", () => suggest.includes(input.value.trim()) && add());
    input.addEventListener("blur", add);
    wrap.append(input, dl);
  }
  return wrap;
}

/** A new property: its name and kind, then its row. */
function addProperty(app, page, list, adder, write) {
  if (list.querySelector(".prop-new")) return list.querySelector(".prop-new input")?.focus();
  const name = el("input", { class: "prop-input", placeholder: "Name", spellcheck: "false" });
  const kind = el("select", { class: "prop-select" }, ...KINDS.map((k) => el("option", { value: k }, KIND_LABELS[k])));
  const problem = el("span", { class: "layr-error prop-problem" });
  const row = el("div", { class: "prop-row prop-new" }, el("div", { class: "prop-key" }, name),
    el("div", { class: "prop-value" }, kind,
      el("button", { class: "layr-button primary small", onclick: () => commit() }, "Add"),
      el("button", { class: "layr-button ghost small", onclick: () => row.remove() }, "Cancel"), problem));
  const commit = async () => {
    const key = name.value.trim();
    if (!key) return name.focus();
    if (/[:#\n]/.test(key)) return (problem.textContent = "No : or # in a name");
    if (key in page.props) return (problem.textContent = "There is a property of that name");
    const k = kind.value;
    const start = k === "checkbox" ? false : k === "multiselect" ? [] : k === "date"
      ? new Date().toISOString().slice(0, 10) : "";
    await write({ [key]: start }).catch((e) => app.ui.fail(e));
  };
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") row.remove();
  });
  list.append(row);
  name.focus();
}

/** Ask for a file, upload it as an attachment; gives its name. */
function pickFile(app) {
  return new Promise((resolve, reject) => {
    const input = el("input", { type: "file", style: { display: "none" } });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      try {
        const record = await app.files.upload(file.name, await file.arrayBuffer(), file.type || null);
        resolve(record.name);
      } catch (error) {
        reject(error);
      }
    });
    document.body.append(input);
    input.click();
  });
}
