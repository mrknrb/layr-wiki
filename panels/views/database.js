// A database view (route `view` {id}): a saved view's pages as a table, board, gallery, calendar or list, with its
// source, filters, sort and layout settings edited in place. Cells write properties through app.wiki.setProps.
import { asList, keyOf } from "../../shared/links.js";
import { dayKey, describeSource, displayValue, editValue, fieldInfo, fieldsOf, groupPages, kindClass, LAYOUTS,
  moveChange, normalizeView, OPS, opsFor, parseDay, runView, sourcePages, textOf, valueOf, dayOf } from "../../shared/query.js";
import { allFolders, allTags, button, draggable, el, fail, icon, IMAGE, lazyImage, pageLink, popover, typeIcon,
  typesInUse, watch } from "./common.js";

const LAYOUT_INFO = {
  table: { title: "Table", icon: "table" },
  board: { title: "Board", icon: "square-kanban" },
  gallery: { title: "Gallery", icon: "layout-grid" },
  calendar: { title: "Calendar", icon: "calendar-days" },
  list: { title: "List", icon: "list" },
};
const KIND_ICON = {
  title: "type", folder: "folder", type: "shapes", tags: "hash", datetime: "clock", count: "link", text: "text",
  number: "hash", date: "calendar", checkbox: "square-check", select: "circle-chevron-down", multiselect: "list",
  link: "link", links: "link", url: "globe", file: "paperclip",
};
const MAX_ROWS = 400;
const READ_ONLY = new Set(["title", "created", "updated", "links", "backlinks", "tags"]);

/** Draw the view `route.id` into `root`. */
export function renderDatabase(root, route, app) {
  const saved = app.savedViews;
  let view = null;
  let search = "";
  let shown = MAX_ROWS;
  let month = null; // the calendar's month: Date of its first day
  root.classList.add("vw-db");

  const save = async (changes) => {
    view = normalizeView({ ...view, ...changes });
    try {
      await saved.save(view);
    } catch (error) {
      fail(app, error);
    }
    draw();
  };

  const draw = () => {
    view = saved.get(route.id) ?? view;
    root.replaceChildren();
    if (!view) {
      root.append(el("div", { class: "layr-empty vw-empty" }, el("p", {}, "This view was deleted."),
        button("plus", "New view", () => newView(app))));
      return;
    }
    const wiki = app.wiki;
    const base = sourcePages(wiki, view.source);
    const fields = fieldsOf(wiki, base, { typeName: view.source.type });
    const rows = runView(wiki, view, { search, fields });
    root.append(header(rows, fields), body(rows, fields));
  };

  // ---------- header: name, source, layout, filter, sort, layout settings ----------

  const header = (rows, fields) => {
    const name = el("button", { class: "vw-db-name", type: "button", title: "Rename this view",
      onclick: async () => {
        const n = await app.ui.prompt("Rename the view", { value: view.name });
        if (n?.trim()) save({ name: n.trim() });
      } }, icon(view.icon || "table"), el("span", {}, view.name));
    const source = el("button", { class: "vw-chip", type: "button", title: "Which pages this view takes",
      onclick: (e) => sourcePopover(e.currentTarget) }, icon("filter"), el("span", {}, describeSource(view.source)));
    const find = el("input", { class: "layr-input vw-db-search", type: "search", placeholder: "Search titles",
      value: search, oninput: (e) => {
        search = e.target.value;
        const pos = e.target.selectionStart;
        draw();
        const again = root.querySelector(".vw-db-search");
        again?.focus();
        again?.setSelectionRange(pos, pos);
      } });
    const top = el("div", { class: "vw-db-top" }, name, source, el("span", { class: "layr-spacer" }), find,
      button("plus", "New", (e) => newRow(null, e), { cls: "primary", title: "New page" }),
      button("ellipsis", "", (e) => moreMenu(e), { title: "More" }));

    const layouts = el("div", { class: "vw-seg", role: "tablist" }, LAYOUTS.map((l) =>
      el("button", { type: "button", role: "tab", class: view.layout === l ? "active" : "", "aria-selected": String(view.layout === l),
        title: LAYOUT_INFO[l].title, onclick: () => setLayout(l) }, icon(LAYOUT_INFO[l].icon),
      el("span", { class: "vw-seg-label" }, LAYOUT_INFO[l].title))));
    const count = (n) => (n ? el("span", { class: "vw-count" }, String(n)) : null);
    const tools = [
      el("button", { class: `vw-tool ${view.filters.length ? "on" : ""}`, type: "button",
        onclick: (e) => filterPopover(e.currentTarget, fields) }, icon("list-filter"), el("span", {}, "Filter"), count(view.filters.length)),
      el("button", { class: `vw-tool ${view.sort.length ? "on" : ""}`, type: "button",
        onclick: (e) => sortPopover(e.currentTarget, fields) }, icon("arrow-up-down"), el("span", {}, "Sort"), count(view.sort.length)),
    ];
    if (view.layout === "table" || view.layout === "list" || view.layout === "gallery" || view.layout === "board") {
      tools.push(el("button", { class: "vw-tool", type: "button", onclick: (e) => columnsPopover(e.currentTarget, fields) },
        icon("columns-3"), el("span", {}, view.layout === "table" ? "Columns" : "Fields")));
    }
    if (view.layout === "board") {
      tools.push(pickTool("Group by", view.groupBy, groupable(fields), (k) => save({ groupBy: k }), fields));
    }
    if (view.layout === "calendar") {
      tools.push(pickTool("Date", view.dateField ?? "created", fields.filter((f) => kindClass(f.kind) === "date"),
        (k) => save({ dateField: k }), fields));
    }
    if (view.layout === "gallery") {
      tools.push(pickTool("Cover", view.coverField, [{ key: null, label: "First picture" },
        ...fields.filter((f) => ["file", "url", "text"].includes(f.kind))], (k) => save({ coverField: k }), fields));
    }
    const bar = el("div", { class: "vw-db-bar" }, layouts, el("div", { class: "vw-tools" }, tools),
      el("span", { class: "layr-spacer" }), el("span", { class: "vw-total layr-muted" }, `${rows.length} pages`));
    return el("div", { class: "vw-db-head" }, top, bar);
  };

  const pickTool = (label, current, options, pick, fields) =>
    el("button", { class: "vw-tool", type: "button", onclick: (e) => popover(e.currentTarget, (pop, close) => {
      pop.append(el("div", { class: "vw-pop-title" }, label), ...options.map((f) =>
        el("button", { type: "button", class: `vw-pop-item ${f.key === current ? "on" : ""}`,
          onclick: () => { close(); pick(f.key); } }, f.key ? icon(KIND_ICON[f.kind] ?? "text") : icon("image"), el("span", {}, f.label))));
      if (!options.length) pop.append(el("p", { class: "layr-muted vw-pop-note" }, "No field of that kind yet."));
    }) }, el("span", {}, `${label}: `), el("b", {}, current === null || current === undefined
      ? (label === "Cover" ? "First picture" : "none") : fieldInfo(fields, current).label));

  const groupable = (fields) => fields.filter((f) => !["title", "datetime", "count", "url"].includes(f.kind) &&
    kindClass(f.kind) !== "date" && f.kind !== "number");

  const setLayout = (layout) => {
    const changes = { layout };
    if (layout === "board" && !view.groupBy) {
      const fields = fieldsOf(app.wiki, sourcePages(app.wiki, view.source), { typeName: view.source.type });
      changes.groupBy = fields.find((f) => f.kind === "select")?.key ?? (view.source.type ? "folder" : "type");
    }
    save(changes);
  };

  const moreMenu = (e) => {
    const items = [
      { label: "Rename", run: async () => {
        const n = await app.ui.prompt("Rename the view", { value: view.name });
        if (n?.trim()) save({ name: n.trim() });
      } },
      { label: "Duplicate", run: async () => {
        const copy = await saved.save({ ...view, id: undefined, name: `${view.name} (copy)`, created: Date.now() });
        app.open({ view: "view", id: copy.id });
      } },
      { label: "Copy as a Markdown table", run: () => copyTable() },
      ...(app.wiki.setBookmarks ? [{ label: "Bookmark", run: () => bookmark(app, view) }] : []),
      "-",
      { label: "Delete view", danger: true, run: async () => {
        if (!(await app.ui.confirm(`Delete the view "${view.name}"? Its pages stay.`, { danger: true }))) return;
        await saved.remove(view.id);
        app.open({ view: "home" }, { replace: true });
      } },
    ];
    app.ui.menu(items, e);
  };

  const copyTable = async () => {
    const { tableText } = await import("../../shared/query.js");
    const fields = fieldsOf(app.wiki, sourcePages(app.wiki, view.source), { typeName: view.source.type });
    const text = tableText(app.wiki, runView(app.wiki, view, { fields }), view.columns, fields, { limit: 100000 });
    await navigator.clipboard?.writeText(text).then(() => app.ui.notify?.("Copied the table"), (e) => fail(app, e));
  };

  // ---------- popovers: source, filters, sort, columns ----------

  const sourcePopover = (anchor) => popover(anchor, (pop) => {
    const wiki = app.wiki;
    const s = { ...view.source };
    const commit = () => save({ source: Object.fromEntries(Object.entries(s).filter(([, v]) => v)) });
    const select = (label, key, options) => el("label", { class: "vw-field" }, el("span", {}, label),
      el("select", { class: "layr-select", onchange: (e) => { s[key] = e.target.value; commit(); } },
        el("option", { value: "" }, "Any"), options.map((o) => el("option", { value: o, selected: keyOf(o) === keyOf(s[key] ?? "\u0000") }, o))));
    const tags = el("datalist", { id: "vw-tags-list" }, allTags(wiki).map((t) => el("option", { value: t })));
    pop.append(
      el("div", { class: "vw-pop-title" }, "Pages from"),
      select("Folder (with its subfolders)", "folder", allFolders(wiki)),
      select("Type", "type", typesInUse(wiki).map((t) => t.name)),
      el("label", { class: "vw-field" }, el("span", {}, "Tag"), el("input", { class: "layr-input", list: "vw-tags-list",
        value: s.tag ?? "", placeholder: "any", onchange: (e) => { s.tag = e.target.value.replace(/^#/, "").trim(); commit(); } }), tags),
      el("label", { class: "vw-field" }, el("span", {}, "Words (search)"), el("input", { class: "layr-input",
        value: s.query ?? "", placeholder: "any", onchange: (e) => { s.query = e.target.value.trim(); commit(); } })),
    );
  });

  const filterPopover = (anchor, fields) => popover(anchor, (pop, close) => {
    const filters = view.filters.map((f) => ({ ...f }));
    const commit = () => {
      view = normalizeView({ ...view, filters });
      saved.save(view).catch((e) => fail(app, e));
      drawBody();
    };
    const list = el("div", { class: "vw-rows" });
    const redraw = () => {
      list.replaceChildren(...filters.map((f, i) => filterRow(f, fields, () => commit(), () => {
        filters.splice(i, 1);
        commit();
        redraw();
      }, redraw)));
      if (!filters.length) list.append(el("p", { class: "layr-muted vw-pop-note" }, "No filters: every page of the source."));
    };
    redraw();
    pop.append(el("div", { class: "vw-pop-title" }, "Filters (all must match)"), list,
      el("div", { class: "vw-pop-actions" }, button("plus", "Add filter", () => {
        filters.push({ field: fields.find((f) => !f.builtIn)?.key ?? "title", op: "is", value: "" });
        filters[filters.length - 1].op = opsFor(fieldInfo(fields, filters[filters.length - 1].field).kind)[0];
        redraw();
        commit();
      }), button(null, "Done", close)));
  }, { cls: "wide" });

  // Only the rows/board/etc. (keeps an open popover).
  const drawBody = () => {
    const old = root.querySelector(".vw-db-head");
    const wiki = app.wiki;
    const base = sourcePages(wiki, view.source);
    const fields = fieldsOf(wiki, base, { typeName: view.source.type });
    const rows = runView(wiki, view, { search, fields });
    const fresh = header(rows, fields);
    old?.replaceWith(fresh);
    root.querySelector(".vw-db-body")?.replaceWith(body(rows, fields));
  };

  const filterRow = (f, fields, commit, remove, redraw) => {
    const info = fieldInfo(fields, f.field);
    const ops = opsFor(info.kind);
    if (!ops.includes(f.op)) f.op = ops[0];
    const value = valueInput(info, f, commit);
    return el("div", { class: "vw-row" },
      fieldSelect(fields, f.field, (k) => {
        f.field = k;
        f.op = opsFor(fieldInfo(fields, k).kind)[0];
        f.value = "";
        commit();
        redraw();
      }),
      el("select", { class: "layr-select vw-op", onchange: (e) => { f.op = e.target.value; commit(); redraw(); } },
        ops.map((o) => el("option", { value: o, selected: o === f.op }, OPS.find((x) => x.op === o).label))),
      OPS.find((x) => x.op === f.op)?.noValue ? el("span", { class: "vw-grow" }) : value,
      button("x", "", remove, { title: "Remove" }));
  };

  const valueInput = (info, f, commit) => {
    const k = kindClass(info.kind);
    const set = (v) => {
      f.value = v;
      commit();
    };
    if (f.op === "within") {
      return el("input", { class: "layr-input vw-grow", type: "number", min: "0", value: f.value || "7",
        onchange: (e) => set(Number(e.target.value)) });
    }
    if (k === "bool") {
      return el("select", { class: "layr-select vw-grow", onchange: (e) => set(e.target.value === "true") },
        el("option", { value: "true", selected: f.value === true || f.value === "true" }, "checked"),
        el("option", { value: "false", selected: !(f.value === true || f.value === "true") }, "not checked"));
    }
    const options = optionsOf(info);
    if (options.length && (f.op === "is" || f.op === "isNot" || k === "list")) {
      return el("select", { class: "layr-select vw-grow", onchange: (e) => set(e.target.value) },
        el("option", { value: "" }, "…"), options.map((o) => el("option", { value: o, selected: keyOf(o) === keyOf(f.value) }, o)));
    }
    if (k === "date") {
      const wrap = el("span", { class: "vw-grow vw-date-op" });
      const input = el("input", { class: "layr-input", type: "text", placeholder: "YYYY-MM-DD, today, -7",
        value: f.value ?? "", onchange: (e) => set(e.target.value.trim()) });
      const pick = el("input", { class: "vw-date-pick", type: "date", title: "Pick a date",
        value: parseDay(f.value) !== null ? String(f.value).slice(0, 10) : "",
        onchange: (e) => { input.value = e.target.value; set(e.target.value); } });
      wrap.append(input, pick);
      return wrap;
    }
    return el("input", { class: "layr-input vw-grow", type: k === "number" ? "number" : "text", value: f.value ?? "",
      placeholder: "value", oninput: debounceInput((v) => set(k === "number" && v !== "" ? Number(v) : v)) });
  };

  const optionsOf = (info) => {
    const wiki = app.wiki;
    if (info.kind === "type") return typesInUse(wiki).map((t) => t.name);
    if (info.kind === "folder") return allFolders(wiki);
    if (info.kind === "tags") return allTags(wiki);
    const found = new Set(info.options ?? []);
    if (["select", "multiselect"].includes(info.kind)) {
      for (const p of sourcePages(wiki, view.source)) for (const v of asList(valueOf(wiki, p, info.key))) found.add(textOf(v));
    }
    return [...found].filter(Boolean);
  };

  const sortPopover = (anchor, fields) => popover(anchor, (pop, close) => {
    const sort = view.sort.map((s) => ({ ...s }));
    const commit = () => {
      view = normalizeView({ ...view, sort });
      saved.save(view).catch((e) => fail(app, e));
      drawBody();
    };
    const list = el("div", { class: "vw-rows" });
    const redraw = () => {
      list.replaceChildren(...sort.map((s, i) => el("div", { class: "vw-row" },
        el("span", { class: "vw-row-n layr-muted" }, i ? "then" : "by"),
        fieldSelect(fields, s.field, (k) => { s.field = k; commit(); }),
        el("select", { class: "layr-select vw-op", onchange: (e) => { s.dir = e.target.value; commit(); } },
          el("option", { value: "asc", selected: s.dir === "asc" }, "ascending"),
          el("option", { value: "desc", selected: s.dir === "desc" }, "descending")),
        button("arrow-up", "", () => { if (i) { sort.splice(i - 1, 0, ...sort.splice(i, 1)); commit(); redraw(); } }, { title: "Earlier" }),
        button("x", "", () => { sort.splice(i, 1); commit(); redraw(); }, { title: "Remove" }))));
      if (!sort.length) list.append(el("p", { class: "layr-muted vw-pop-note" }, "By title (A to Z)."));
    };
    redraw();
    pop.append(el("div", { class: "vw-pop-title" }, "Sort"), list, el("div", { class: "vw-pop-actions" },
      button("plus", "Add sort", () => { sort.push({ field: "updated", dir: "desc" }); commit(); redraw(); }),
      button(null, "Done", close)));
  }, { cls: "wide" });

  const columnsPopover = (anchor, fields) => popover(anchor, (pop) => {
    let cols = [...view.columns];
    const commit = () => {
      view = normalizeView({ ...view, columns: cols.length ? cols : ["title"] });
      saved.save(view).catch((e) => fail(app, e));
      drawBody();
    };
    const list = el("div", { class: "vw-cols" });
    const redraw = () => {
      const ordered = [...cols.map((c) => fieldInfo(fields, c)), ...fields.filter((f) => !cols.includes(f.key))];
      list.replaceChildren(...ordered.map((f) => {
        const on = cols.includes(f.key);
        const i = cols.indexOf(f.key);
        return el("div", { class: `vw-col ${on ? "on" : ""}` },
          el("label", {}, el("input", { type: "checkbox", checked: on, disabled: f.key === "title" && view.layout === "table",
            onchange: (e) => {
              cols = e.target.checked ? [...cols, f.key] : cols.filter((c) => c !== f.key);
              commit();
              redraw();
            } }), icon(KIND_ICON[f.kind] ?? "text"), el("span", {}, f.label)),
          on && i > 0 ? button("arrow-up", "", () => { cols.splice(i - 1, 0, ...cols.splice(i, 1)); commit(); redraw(); },
            { title: "Move left" }) : null);
      }));
    };
    redraw();
    pop.append(el("div", { class: "vw-pop-title" }, view.layout === "table" ? "Columns" : "Fields on the cards"), list);
  });

  const fieldSelect = (fields, current, pick) =>
    el("select", { class: "layr-select vw-fieldsel", onchange: (e) => pick(e.target.value) },
      el("optgroup", { label: "Page" }, fields.filter((f) => f.builtIn).map((f) =>
        el("option", { value: f.key, selected: f.key === current }, f.label))),
      el("optgroup", { label: "Properties" }, fields.filter((f) => !f.builtIn).map((f) =>
        el("option", { value: f.key, selected: f.key === current }, f.label))));

  // ---------- writing values ----------

  const write = async (page, info, value) => {
    try {
      if (info.kind === "folder") {
        if (!app.wiki.move) throw new Error("Moving pages to folders needs the newer wiki");
        await app.wiki.move(page.id, value ?? "");
      } else {
        const key = info.key.startsWith("prop:") ? info.key.slice(5) : info.key;
        await app.wiki.setProps(page.id, { [key]: value });
      }
    } catch (error) {
      fail(app, error);
    }
  };

  /** A new page that lands in this view: in its folder, of its type, with its tag, and the given field values. */
  const newRow = async (preset, e) => {
    const title = await app.ui.prompt("New page", { placeholder: "Title", label: `In “${view.name}”` });
    if (!title?.trim()) return;
    try {
      const props = { ...(preset ?? {}) };
      if (view.source.tag) props.tags = [view.source.tag];
      const folder = preset?.__folder ?? view.source.folder ?? "";
      delete props.__folder;
      const page = await app.wiki.create({ title: title.trim(), folder, type: view.source.type ?? null,
        ...(Object.keys(props).length ? { properties: props } : {}) });
      // Older models don't take `properties`: set them after.
      const missing = Object.fromEntries(Object.entries(props).filter(([k]) => page.props?.[k] === undefined));
      if (Object.keys(missing).length) await app.wiki.setProps(page.id, missing);
      if (e?.ctrlKey || e?.metaKey) app.openPage(page.id, { newTab: true });
    } catch (error) {
      fail(app, error);
    }
  };

  // ---------- body by layout ----------

  const body = (rows, fields) => {
    const wrap = el("div", { class: `vw-db-body vw-${view.layout}` });
    if (!rows.length) {
      wrap.append(el("div", { class: "layr-empty vw-empty" },
        el("p", {}, search ? `No page title holds “${search}”.` : view.filters.length ? "No page matches the filters."
          : `No pages in ${describeSource(view.source).toLowerCase()} yet.`),
        button("plus", "New page", (e) => newRow(null, e))));
      if (view.layout !== "calendar") return wrap;
    }
    if (view.layout === "table") wrap.append(table(rows, fields));
    else if (view.layout === "board") wrap.append(board(rows, fields));
    else if (view.layout === "gallery") wrap.append(gallery(rows, fields));
    else if (view.layout === "calendar") wrap.append(calendar(rows, fields));
    else wrap.append(list(rows, fields));
    return wrap;
  };

  // Table: columns sized and ordered by dragging their headers; cells edited in place.
  const table = (rows, fields) => {
    const cols = view.columns.map((c) => fieldInfo(fields, c));
    const widths = view.widths ?? {};
    const colgroup = el("colgroup", {}, cols.map((c) => el("col", { style: { width: `${widths[c.key] ?? defaultWidth(c)}px` } })));
    const head = el("tr", {}, cols.map((c, i) => {
      const sorted = view.sort.find((s) => s.field === c.key);
      const th = el("th", { "data-key": c.key, title: c.label },
        el("div", { class: "vw-th" }, icon(KIND_ICON[c.kind] ?? "text"), el("span", { class: "vw-th-label" }, c.label),
          sorted ? icon(sorted.dir === "asc" ? "arrow-up" : "arrow-down", "vw-sorted") : null),
        el("span", { class: "vw-resize", title: "Drag to resize" }));
      th.addEventListener("click", (e) => {
        if (e.target.closest(".vw-resize")) return;
        columnMenu(c, e);
      });
      resizer(th.querySelector(".vw-resize"), c, colgroup.children[i]);
      draggable(th, { targets: ".vw-table th", ghost: false, drop: (target) => {
        const to = target.dataset.key;
        if (!to || to === c.key) return;
        const next = view.columns.filter((k) => k !== c.key);
        next.splice(next.indexOf(to) + (view.columns.indexOf(to) > view.columns.indexOf(c.key) ? 1 : 0), 0, c.key);
        save({ columns: next });
      } });
      return th;
    }));
    const tbody = el("tbody", {});
    for (const page of rows.slice(0, shown)) tbody.append(el("tr", { "data-id": page.id }, cols.map((c) => cell(page, c))));
    const foot = el("tr", { class: "vw-new-row" }, el("td", { colspan: String(cols.length) },
      el("button", { type: "button", class: "vw-add", onclick: (e) => newRow(null, e) }, icon("plus"), el("span", {}, "New"))));
    tbody.append(foot);
    const tableEl = el("table", { class: "vw-table" }, colgroup, el("thead", {}, head), tbody);
    const out = el("div", { class: "vw-table-wrap" }, tableEl);
    if (rows.length > shown) {
      out.append(el("div", { class: "vw-more" }, button(null, `Show ${Math.min(MAX_ROWS, rows.length - shown)} more of ${rows.length - shown}`,
        () => { shown += MAX_ROWS; drawBody(); })));
    }
    return out;
  };

  const defaultWidth = (c) => (c.key === "title" ? 240 : c.kind === "checkbox" ? 90 : c.kind === "count" ? 100
    : c.kind === "datetime" || c.kind === "date" ? 130 : c.kind === "number" ? 110 : 170);

  const resizer = (handle, c, col) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = col.getBoundingClientRect().width || defaultWidth(c);
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => (col.style.width = `${Math.max(60, Math.round(startW + ev.clientX - startX))}px`);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        view = normalizeView({ ...view, widths: { ...view.widths, [c.key]: parseInt(col.style.width, 10) } });
        saved.save(view).catch((err) => fail(app, err));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  };

  const columnMenu = (c, e) => {
    app.ui.menu([
      { label: "Sort ascending", run: () => save({ sort: [{ field: c.key, dir: "asc" }, ...view.sort.filter((s) => s.field !== c.key)] }) },
      { label: "Sort descending", run: () => save({ sort: [{ field: c.key, dir: "desc" }, ...view.sort.filter((s) => s.field !== c.key)] }) },
      { label: "Filter by this", run: () => {
        save({ filters: [...view.filters, { field: c.key, op: opsFor(c.kind)[0], value: "" }] });
        setTimeout(() => root.querySelector(".vw-tool")?.click(), 50);
      } },
      ...(c.key !== "title" ? ["-", { label: "Hide column", run: () => save({ columns: view.columns.filter((k) => k !== c.key) }) }] : []),
    ], e);
  };

  /** A table cell: the value, and an editor by its kind on click. */
  const cell = (page, info) => {
    const wiki = app.wiki;
    const value = valueOf(wiki, page, info.key);
    const td = el("td", { class: `vw-cell k-${info.kind}` });
    if (info.key === "title") {
      td.append(el("div", { class: "vw-title-cell" }, typeIcon(wiki, page.type), pageLink(page)));
      return td;
    }
    if (info.kind === "checkbox") {
      td.append(el("input", { type: "checkbox", class: "vw-check", checked: valueOf(wiki, page, info.key) === true ||
        /^(true|yes|1|x)$/i.test(String(value ?? "")), onchange: (e) => write(page, info, e.target.checked) }));
      return td;
    }
    td.append(show(info, value));
    if (READ_ONLY.has(info.key) || (info.kind === "folder" && !wiki.move)) {
      td.classList.add("ro");
      return td;
    }
    td.tabIndex = 0;
    const edit = () => {
      if (td.querySelector("input, select")) return;
      const editor = cellEditor(info, value, async (v) => {
        // Show the value at once and take the focus off the editor (a redraw waits while an input has it).
        td.replaceChildren(show(info, v === undefined ? value : v));
        td.focus({ preventScroll: true });
        if (v !== undefined) await write(page, info, v);
      });
      td.replaceChildren(editor);
      editor.focus();
      if (editor.select && editor.type !== "date") editor.select?.();
      if (editor.tagName === "SELECT") editor.showPicker?.();
    };
    td.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      edit();
    });
    td.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === "F2") && e.target === td) {
        e.preventDefault();
        edit();
      }
    });
    return td;
  };

  /** A value shown in a cell or on a card. */
  const show = (info, value) => {
    const wiki = app.wiki;
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      return el("span", { class: "vw-empty-val" }, "");
    }
    const k = kindClass(info.kind);
    if (info.kind === "type") return el("span", { class: "vw-pill", style: { "--pill": `${typeColorOf(value)}` } }, typeIcon(wiki, value), String(value));
    if (k === "list" || info.kind === "select") {
      return el("span", { class: "vw-pills" }, asList(value).map((v) => {
        const t = textOf(v);
        const target = /^\s*\[\[/.test(String(v)) ? wiki.resolve(t) : null;
        return target ? pageLink(target, t) : el("span", { class: "vw-pill", style: { "--pill": pillColor(info, t) } },
          info.kind === "tags" ? `#${t}` : t);
      }));
    }
    if (info.kind === "link" || info.kind === "file") {
      const t = textOf(value);
      const target = info.kind === "link" ? wiki.resolve(t) : null;
      return target ? pageLink(target, t) : el("span", { class: info.kind === "link" ? "vw-missing" : "" }, t);
    }
    if (info.kind === "url") {
      return el("a", { href: String(value), target: "_blank", rel: "noopener", class: "vw-url" }, String(value).replace(/^https?:\/\//, ""));
    }
    if (info.kind === "datetime") return el("span", { title: new Date(value).toLocaleString() }, dayKey(value));
    return el("span", {}, displayValue(info, value));
  };

  const typeColorOf = (name) => app.wiki.type?.(name)?.color || "var(--accent)";
  const pillColor = (info, t) => {
    const i = (info.options ?? []).findIndex((o) => keyOf(o) === keyOf(t));
    const colors = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#b07aa1", "#76b7b2", "#edc948", "#9c755f"];
    return i >= 0 ? colors[i % colors.length] : "var(--fg-dim)";
  };

  /** An editor for one value; `done(value)` (undefined: cancelled). */
  const cellEditor = (info, value, done) => {
    let finished = false;
    const finish = (v) => {
      if (finished) return;
      finished = true;
      done(v);
    };
    const keys = (input, read) => {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(undefined);
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(read());
        }
      });
      input.addEventListener("blur", () => finish(read()));
    };
    const options = info.kind === "type" ? typesInUse(app.wiki).map((t) => t.name) : info.kind === "folder"
      ? ["", ...allFolders(app.wiki)] : info.kind === "select" ? [...new Set([...(info.options ?? []), ...optionsOf(info)])] : null;
    if (options) {
      const current = info.kind === "folder" ? value ?? "" : textOf(value);
      const sel = el("select", { class: "vw-cell-input layr-select" },
        info.kind !== "folder" ? el("option", { value: "" }, "—") : null,
        options.map((o) => el("option", { value: o, selected: keyOf(o) === keyOf(current) }, o || "Top folder")),
        current && !options.some((o) => keyOf(o) === keyOf(current)) ? el("option", { value: current, selected: true }, current) : null);
      sel.addEventListener("change", () => finish(info.kind === "folder" ? sel.value : sel.value ? editValue(info, sel.value) : null));
      sel.addEventListener("blur", () => finish(undefined));
      sel.addEventListener("keydown", (e) => e.key === "Escape" && finish(undefined));
      return sel;
    }
    const k = kindClass(info.kind);
    const text = k === "list" ? asList(value).map(textOf).join(", ") : info.kind === "date" ? String(value ?? "").slice(0, 10)
      : textOf(value);
    const input = el("input", { class: "vw-cell-input layr-input", value: text,
      type: info.kind === "number" ? "number" : info.kind === "date" ? "date" : info.kind === "url" ? "url" : "text",
      step: info.kind === "number" ? "any" : null });
    if (info.kind === "link" || info.kind === "links" || info.kind === "multiselect") {
      const id = `vw-dl-${Math.random().toString(36).slice(2)}`;
      const values = info.kind === "multiselect" ? optionsOf(info)
        : app.wiki.live().filter((p) => !info.target || keyOf(p.type) === keyOf(info.target)).map((p) => p.title).slice(0, 2000);
      input.setAttribute("list", id);
      const dl = el("datalist", { id }, values.map((v) => el("option", { value: v })));
      const box = el("span", { class: "vw-cell-box" }, input, dl);
      keys(input, () => editValue(info, input.value));
      box.focus = () => input.focus();
      box.select = () => input.select();
      return box;
    }
    keys(input, () => editValue(info, input.value));
    return input;
  };

  // Board: a column per value of the group field; cards dragged between them change it.
  const board = (rows, fields) => {
    const field = view.groupBy ?? "type";
    const info = fieldInfo(fields, field);
    const groups = groupPages(app.wiki, rows, field, fields);
    const shownFields = view.columns.filter((c) => c !== "title" && c !== field).slice(0, 4).map((c) => fieldInfo(fields, c));
    const canMove = moveChange(app.wiki, rows[0] ?? { props: {} }, field, null, "x", fields) !== null;
    return el("div", { class: "vw-board-cols" }, groups.map((g) => {
      const colEl = el("section", { class: "vw-board-col", "data-value": g.value === null ? "" : g.value,
        "data-none": g.value === null ? "1" : null },
      el("header", {}, info.kind === "type" && g.value ? typeIcon(app.wiki, g.value) : null,
        el("span", { class: "vw-board-label" }, g.label), el("span", { class: "vw-count" }, String(g.pages.length))),
      el("div", { class: "vw-board-cards" }, g.pages.map((p) => {
        const c = card(p, shownFields, "vw-board-card");
        if (canMove) {
          draggable(c, { targets: ".vw-board-col", drop: async (target) => {
            const to = target.dataset.none ? null : target.dataset.value;
            if (keyOf(to ?? "") === keyOf(g.value ?? "")) return;
            const change = moveChange(app.wiki, p, field, g.value, to, fields);
            try {
              if (change?.folder !== undefined) await app.wiki.move?.(p.id, change.folder);
              else if (change?.props) await app.wiki.setProps(p.id, change.props);
            } catch (error) {
              fail(app, error);
            }
          } });
        }
        return c;
      })),
      canMove || info.kind === "folder" ? el("button", { type: "button", class: "vw-add", onclick: (e) => {
        const preset = g.value === null ? {} : info.kind === "folder" ? { __folder: g.value }
          : moveChange(app.wiki, { props: {} }, field, null, g.value, fields)?.props ?? {};
        newRow(preset, e);
      } }, icon("plus"), el("span", {}, "New")) : null);
      return colEl;
    }));
  };

  /** A card: title (a link), then a few fields. */
  const card = (page, shownFields, cls) => el("article", { class: `vw-card ${cls}`, "data-id": page.id,
    onclick: (e) => {
      if (e.target.closest("a, input, button")) return;
      app.openPage(page.id, { newTab: e.ctrlKey || e.metaKey });
    } },
  el("div", { class: "vw-card-title" }, typeIcon(app.wiki, page.type), pageLink(page)),
  shownFields.map((f) => {
    const v = valueOf(app.wiki, page, f.key);
    if (!displayValue(f, v)) return null;
    return el("div", { class: "vw-card-field" }, el("span", { class: "vw-card-key" }, f.label), show(f, v));
  }));

  // Gallery: cards with a cover picture.
  const gallery = (rows, fields) => {
    const shownFields = view.columns.filter((c) => c !== "title").slice(0, 3).map((c) => fieldInfo(fields, c));
    return el("div", { class: "vw-gallery-grid" }, rows.slice(0, shown).map((p) => {
      const c = card(p, shownFields, "vw-gallery-card");
      const name = coverOf(p);
      const cover = el("div", { class: "vw-cover" });
      if (name) {
        const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
        cover.append(img);
        lazyImage(app, img, name, () => cover.replaceChildren(placeholder(p)));
      } else cover.append(placeholder(p));
      c.prepend(cover);
      return c;
    }));
  };
  const coverOf = (page) => {
    if (view.coverField) {
      const v = textOf(asList(valueOf(app.wiki, page, view.coverField))[0] ?? "");
      if (v && (IMAGE.test(v) || /^https?:/.test(v))) return v;
    }
    const pic = (page.files ?? []).find((f) => IMAGE.test(f));
    if (pic) return pic;
    const web = /!\[[^\]]*\]\((https?:[^)\s]+)\)/.exec(page.body ?? "");
    return web ? web[1] : null;
  };
  const placeholder = (p) => el("div", { class: "vw-cover-none" }, typeIcon(app.wiki, p.type, "big"),
    el("span", {}, plainText(p.body).slice(0, 140)));

  // Calendar: a month; pages on the day of the date field; drag a page to another day.
  const calendar = (rows, fields) => {
    const field = view.dateField ?? "created";
    const info = fieldInfo(fields, field);
    const writable = !info.builtIn;
    const byDay = new Map();
    for (const p of rows) {
      const d = dayOf(app.wiki, p, field);
      if (!d) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(p);
    }
    if (!month) {
      const now = new Date();
      month = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    const title = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const undated = rows.filter((p) => !dayOf(app.wiki, p, field)).length;
    const nav = el("div", { class: "vw-cal-nav" },
      button("chevron-left", "", () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); drawBody(); }, { title: "Previous month" }),
      el("b", {}, title),
      button("chevron-right", "", () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); drawBody(); }, { title: "Next month" }),
      button(null, "Today", () => { const n = new Date(); month = new Date(n.getFullYear(), n.getMonth(), 1); drawBody(); }),
      el("span", { class: "layr-spacer" }),
      undated ? el("span", { class: "layr-muted" }, `${undated} without ${info.label.toLowerCase()}`) : null);
    const grid = el("div", { class: "vw-cal-grid" });
    for (const d of weekdayNames()) grid.append(el("div", { class: "vw-cal-dow" }, d));
    const today = dayKey(Date.now());
    for (const day of monthDays(month)) {
      const key = dayKey(day);
      const pages = byDay.get(key) ?? [];
      const cellEl = el("div", { class: `vw-cal-day ${day.getMonth() !== month.getMonth() ? "out" : ""} ${key === today ? "today" : ""}`,
        "data-day": key },
      el("div", { class: "vw-cal-num" }, String(day.getDate()),
        writable ? el("button", { type: "button", class: "vw-cal-add", title: "New page on this day",
          onclick: (e) => newRow({ [info.key.replace(/^prop:/, "")]: key }, e) }, icon("plus")) : null),
      pages.slice(0, 6).map((p) => {
        const item = el("div", { class: "vw-cal-item", title: p.title, style: { "--pill": app.wiki.type?.(p.type)?.color || "var(--accent)" } },
          pageLink(p));
        if (writable) {
          draggable(item, { targets: ".vw-cal-day", drop: (target) => {
            const to = target.dataset.day;
            if (to && to !== key) write(p, info, to);
          } });
        }
        return item;
      }),
      pages.length > 6 ? el("button", { type: "button", class: "vw-cal-more", onclick: (e) => app.ui.menu(pages.slice(6)
        .map((p) => ({ label: p.title, run: () => app.openPage(p.id) })), e) }, `+${pages.length - 6} more`) : null);
      grid.append(cellEl);
    }
    return el("div", { class: "vw-cal" }, nav, grid);
  };

  // List: one line per page.
  const list = (rows, fields) => {
    const shownFields = view.columns.filter((c) => c !== "title").slice(0, 4).map((c) => fieldInfo(fields, c));
    const ul = el("ul", { class: "vw-list-rows" }, rows.slice(0, shown).map((p) => el("li", {
      onclick: (e) => !e.target.closest("a") && app.openPage(p.id, { newTab: e.ctrlKey || e.metaKey }) },
    typeIcon(app.wiki, p.type), el("span", { class: "vw-list-title" }, pageLink(p)),
    el("span", { class: "vw-list-fields" }, shownFields.map((f) => {
      const v = valueOf(app.wiki, p, f.key);
      return !displayValue(f, v) ? null : el("span", { class: "vw-list-field", title: f.label }, show(f, v));
    })))));
    return ul;
  };

  const off = saved.on(() => {
    if (!root.querySelector(".vw-pop")) draw();
  });
  const unwatch = watch(app, root, () => {
    if (!document.querySelector(".vw-pop")) draw();
    else drawBody();
  });
  saved.ready().then(draw);
  draw();
  return () => {
    off();
    unwatch();
    root.classList.remove("vw-db");
  };
}

/** A page's text as plain words for a card: links as their text, Markdown signs left out. */
const plainText = (md) => String(md ?? "")
  .replace(/!\[\[[^\]]*\]\]/g, " ")
  .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, t, label) => label ?? t)
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/^\s*(?:[-*+]|\d+\.)\s+\[.\]\s*/gm, "")
  .replace(/[#>*_`~=]|%%[^%]*%%/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const debounceInput = (fn, ms = 350) => {
  let t = null;
  return (e) => {
    clearTimeout(t);
    const v = e.target.value;
    t = setTimeout(() => fn(v), ms);
  };
};

/** The weekday names, Monday first. */
export function weekdayNames() {
  const base = new Date(2024, 0, 1); // a Monday
  return Array.from({ length: 7 }, (_, i) => new Date(base.getTime() + i * 86400000).toLocaleDateString(undefined, { weekday: "short" }));
}

/** The days a month's grid shows: from the Monday on or before the 1st, whole weeks (6 rows at most). */
export function monthDays(first) {
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - ((first.getDay() + 6) % 7));
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const days = [];
  for (let d = new Date(start); d <= last || days.length % 7; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    days.push(d);
  }
  return days;
}

/** Pin a view to the bookmarks. */
export async function bookmark(app, view) {
  const list = app.wiki.bookmarks?.() ?? [];
  if (list.some((b) => b.kind === "view" && b.target === view.id)) return app.ui.notify?.("It is bookmarked already");
  await app.wiki.setBookmarks([...list, { kind: "view", target: view.id, title: view.name }]);
  app.ui.notify?.(`Bookmarked “${view.name}”`);
}

/** A new, empty view (all pages as a table), opened. */
export async function newView(app, source = {}) {
  return app.savedViews.createFor(source, { fresh: true, name: "New view" });
}
