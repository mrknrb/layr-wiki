// The Settings page: made from shared/settings.js (GROUPS, SETTINGS), every change live; the keyboard shortcuts
// editor; and the folder copy's two layr settings (they are about this PC, so they live in layr's settings).
import { add, el, icon, put } from "./dom.js";
import { DEFAULTS, GROUPS, SETTINGS } from "../../shared/settings.js";
import { keyFromEvent, keyLabel, normalizeKey } from "./pure.js";

const PC_GROUP = { id: "pc", title: "Folder copy (this PC)", icon: "hard-drive" };
const ICON_NAMES = { edit: "pencil", event_note: "calendar-days", auto_awesome: "sparkles", public: "globe" };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function registerSettingsPage(app) {
  app.views.register("settings", {
    title: "Settings",
    icon: "settings",
    redraw: false,
    render(root, route) {
      const groups = [...GROUPS, PC_GROUP];
      let group = groups.some((g) => g.id === route.group) ? route.group : groups[0].id;
      const nav = el("nav", { class: "wiki-settings-nav", "aria-label": "Settings groups" });
      const body = el("div", { class: "wiki-settings-body" });
      add(root, el("div", { class: "wiki-settings" }, nav, body));
      const drawNav = () => put(nav, el("div", { class: "wiki-settings-nav-title" }, "Settings"),
        ...groups.map((g) => el("button", { class: `wiki-settings-nav-item${g.id === group ? " active" : ""}`,
          "data-group": g.id, onclick: () => {
            group = g.id;
            app.updateRoute({ group: g.id });
            drawNav();
            draw();
          } }, icon(ICON_NAMES[g.icon] ?? g.icon), el("span", {}, g.title))));
      let cleanupGroup = null;
      const draw = () => {
        cleanupGroup?.();
        cleanupGroup = null;
        const g = groups.find((x) => x.id === group);
        put(body, el("h1", { class: "wiki-view-title" }, g.title));
        body.scrollTop = 0;
        if (g.id === "pc") cleanupGroup = drawPc(app, body);
        else if (g.id === "hotkeys") cleanupGroup = drawHotkeys(app, body);
        else drawGroup(app, body, g.id);
      };
      drawNav();
      draw();
      // Another tab or device changed the settings: show the new values (not while a field here has the focus).
      const off = app.on("settings", ({ ids } = {}) => {
        if (ids && !ids.length) return;
        if (body.contains(document.activeElement) && document.activeElement.matches("input, select, textarea")) return;
        if (group !== "hotkeys") draw();
      });
      return () => {
        off();
        cleanupGroup?.();
      };
    },
  });
}

function row(s, control, { onReset, changed }) {
  return el("div", { class: "wiki-setting", "data-setting": s.id },
    el("div", { class: "wiki-setting-text" },
      el("div", { class: "wiki-setting-title" }, s.title),
      s.description ? el("div", { class: "wiki-setting-desc" }, s.description) : null),
    el("div", { class: "wiki-setting-control" }, control,
      el("button", { class: `layr-button ghost icon small wiki-setting-reset${changed ? "" : " invisible"}`,
        title: "Back to the default", "aria-label": `Reset ${s.title}`, onclick: onReset }, icon("rotate-ccw"))));
}

function drawGroup(app, body, groupId) {
  const list = el("div", { class: "wiki-settings-list" });
  add(body, list);
  const set = (id, value) => app.settings.set({ [id]: value }).catch(app.ui.fail);
  const fill = () => put(list, ...SETTINGS.filter((s) => s.group === groupId).map((s) => {
    const value = app.settings.get(s.id);
    const changed = !same(value, DEFAULTS[s.id]);
    const update = (v) => set(s.id, v).then(() => fill());
    return row(s, control(app, s, value, update), { changed, onReset: () => update(null) });
  }));
  fill();
}

function control(app, s, value, update) {
  if (s.type === "boolean") {
    return el("label", { class: "wiki-switch" }, el("input", { type: "checkbox", checked: value || null,
      "aria-label": s.title,
      onchange: (e) => update(e.target.checked) }), el("span", { class: "wiki-switch-track" }));
  }
  if (s.type === "enum") {
    return el("select", { class: "layr-select", "aria-label": s.title, onchange: (e) => update(e.target.value) },
      ...s.options.map((o) => el("option", { value: o.value, selected: o.value === value || null }, o.label)));
  }
  if (s.type === "number") {
    const input = el("input", { class: "layr-input wiki-number", type: "number", value: String(value), min: s.min,
      max: s.max,
      step: s.step ?? 1, "aria-label": s.title });
    input.addEventListener("change", () => {
      const n = Number(input.value);
      if (Number.isFinite(n)) update(n);
    });
    return input;
  }
  if (s.type === "color") {
    const color = el("input", { type: "color", class: "wiki-color", value: value || "#3d63dd", "aria-label": s.title });
    // While the picker is open the accent follows it (saved once it closes).
    color.addEventListener("input", () => {
      if (s.id !== "accent") return;
      document.documentElement.style.setProperty("--wiki-accent", color.value);
      document.documentElement.dataset.wikiAccent = "";
    });
    color.addEventListener("change", () => update(color.value));
    return el("span", { class: "wiki-row" }, color,
      value ? el("span", { class: "wiki-color-text" }, value) : el("span", { class: "layr-muted" }, "layr's"));
  }
  if (s.type === "colors") return paletteEditor(app, s, value, update);
  const input = el("input", { class: "layr-input wiki-text", value: value ?? "",
    placeholder: String(DEFAULTS[s.id] ?? ""),
    spellcheck: "false", "aria-label": s.title });
  input.addEventListener("change", () => update(input.value.trim()));
  input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
  return input;
}

/** The text and highlight colours: name and colour each, reorder, add, remove. */
function paletteEditor(app, s, value, update) {
  const list = Array.isArray(value) ? value.map((c) => ({ ...c })) : [];
  const box = el("div", { class: "wiki-palette" });
  const save = () => update(list.map((c) => ({ name: c.name || c.color, color: c.color })));
  list.forEach((c, i) => {
    const color = el("input", { type: "color", class: "wiki-color",
      value: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#888888",
      "aria-label": `Colour ${i + 1}` });
    color.addEventListener("change", () => {
      c.color = color.value;
      save();
    });
    const name = el("input", { class: "layr-input wiki-palette-name", value: c.name ?? "",
      "aria-label": `Name of colour ${i + 1}` });
    name.addEventListener("change", () => {
      c.name = name.value.trim();
      save();
    });
    const move = (to) => {
      const [x] = list.splice(i, 1);
      list.splice(to, 0, x);
      save();
    };
    add(box, el("div", { class: "wiki-palette-row" }, color, name,
      el("span", { class: "wiki-palette-sample", style: { color: c.color } }, "Text"),
      el("span", { class: "wiki-palette-sample mark",
        style: { background: `color-mix(in srgb, ${c.color} 45%, transparent)` } },
        "Mark"),
      el("button", { class: "layr-button ghost icon small", title: "Move up", "aria-label": "Move up",
        disabled: i === 0 || null,
        onclick: () => move(i - 1) }, icon("arrow-up")),
      el("button", { class: "layr-button ghost icon small", title: "Move down", "aria-label": "Move down",
        disabled: i === list.length - 1 || null, onclick: () => move(i + 1) }, icon("arrow-down")),
      el("button", { class: "layr-button ghost icon small", title: "Remove", "aria-label": "Remove", onclick: () => {
        list.splice(i, 1);
        save();
      } }, icon("x"))));
  });
  add(box, el("button", { class: "layr-button small", onclick: () => {
    list.push({ name: "New colour", color: "#888888" });
    save();
  } }, icon("plus"), " Add a colour"));
  return box;
}

// ---------- keyboard shortcuts ----------

function drawHotkeys(app, body) {
  const filter = el("input", { class: "layr-input", type: "search", placeholder: "Filter commands or keys",
    "aria-label": "Filter commands" });
  const list = el("div", { class: "wiki-settings-list wiki-hotkeys" });
  add(body, el("p", { class: "layr-muted" }, "Click a shortcut, then press the keys. Backspace removes it, Escape " +
    "cancels. Some keys belong to layr itself (Ctrl+Shift+P, Ctrl+Q)."), filter, list);
  let recording = null;
  let stopRecording = () => {};

  const fill = () => {
    const overrides = app.settings.get("hotkeys") ?? {};
    const { byId, byKey } = app.commands.keys();
    const q = filter.value.trim().toLowerCase();
    const cmds = app.commands.all().filter((c) => c.title && !c.hidden)
      .filter((c) => !q || c.title.toLowerCase().includes(q) || keyLabel(byId.get(c.id)).toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title));
    put(list, ...cmds.map((c) => {
      const key = byId.get(c.id) ?? "";
      const custom = Object.prototype.hasOwnProperty.call(overrides,
        c.id) && normalizeKey(overrides[c.id]) !== normalizeKey(c.key ?? "");
      const clash = key && (byKey.get(key) ?? []).filter((id) => id !== c.id);
      const chip = el("button",
        { class: `wiki-keychip${recording === c.id ? " recording" : ""}${clash?.length ? " clash" : ""}`,
        "data-command": c.id, title: "Click and press the new keys", onclick: () => record(c.id) },
      recording === c.id ? "Press keys…" : key ? keyLabel(key) : "Blank");
      return el("div", { class: "wiki-setting" },
        el("div", { class: "wiki-setting-text" }, el("div", { class: "wiki-setting-title" }, c.title),
          clash?.length ? el("div", { class: "wiki-setting-desc layr-error" },
            `Also on: ${clash.map((id) => app.commands.get(id)?.title ?? id).join(", ")}`) : null),
        el("div", { class: "wiki-setting-control" }, chip,
          key ? el("button", { class: "layr-button ghost icon small", title: "Remove the shortcut",
            "aria-label": "Remove",
            onclick: () => setKey(c.id, "") }, icon("x")) : null,
          el("button", { class: "layr-button ghost icon small wiki-setting-reset", title: "Back to the default",
            "aria-label": "Reset", hidden: !custom || null, onclick: () => setKey(c.id, null) }, icon("rotate-ccw"))));
    }));
  };

  const setKey = (id, key) => {
    const next = { ...(app.settings.get("hotkeys") ?? {}) };
    if (key === null) delete next[id];
    else next[id] = key;
    return app.settings.set({ hotkeys: next }).catch(app.ui.fail).then(fill);
  };

  function record(id) {
    stopRecording();
    recording = id;
    fill();
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return done();
      if (e.key === "Backspace" || e.key === "Delete") return done("");
      const key = keyFromEvent(e);
      if (!key) return;
      done(key);
    };
    const away = (e) => !e.target.closest?.(".wiki-keychip.recording") && done();
    const done = (key) => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", away, true);
      stopRecording = () => {};
      recording = null;
      if (key === undefined) fill();
      else setKey(id, key);
    };
    stopRecording = () => done();
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => document.addEventListener("mousedown", away, true), 0);
  }

  filter.addEventListener("input", fill);
  fill();
  return () => stopRecording();
}

// ---------- the folder copy (layr settings for this plugin, on this PC) ----------

function drawPc(app, body) {
  const box = el("div", { class: "wiki-settings-list" });
  const status = el("div", { class: "wiki-pc-status layr-muted" }, "…");
  add(body, el("p", { class: "layr-muted" },
    "Every page as a Markdown file and every attachment as a file, kept up to " +
    "date on this PC. Obsidian can open the folder. These two settings are layr's (they are about this PC)."), box,
  el("h3", { class: "wiki-settings-sub" }, "Now"), status,
  el("div", { class: "wiki-row" },
    el("button", { class: "layr-button small", onclick: async () => {
      try {
        showStatus(await app.tools("mirror_now", {}));
        app.ui.notify("Folder copy written", "success");
      } catch (error) {
        app.ui.fail(error);
      }
    } }, icon("refresh-cw"), " Write the folder copy now"),
    el("button", { class: "layr-button small", onclick: () => app.commands.run("import-folder") }, icon("folder-input"),
      " Import a folder…"),
    el("button", { class: "layr-button ghost small", onclick: () => openLayrSettings(app) }, icon("external-link"),
      " layr's settings")));

  const specs = [
    { id: "mirror", type: "boolean", title: "Keep a copy in a folder", default: true },
    { id: "folder", type: "string", title: "Folder of the copy",
      description: "Empty: Documents\\layr wiki in your user folder.",
      default: "" },
  ];
  let alive = true;
  (async () => {
    let values = {};
    let writable = true;
    try {
      values = (await layr.settings.get()) ?? {};
    } catch {
      writable = false;
    }
    if (!alive) return;
    put(box, ...specs.map((s) => {
      const value = values[s.id] ?? s.default;
      const update = async (v) => {
        try {
          await layr.settings.set(s.id, v);
          app.ui.notify("Saved", "success");
          setTimeout(loadStatus, 800);
        } catch (error) {
          app.ui.fail(error);
        }
      };
      let c;
      if (s.type === "boolean") {
        c = el("label", { class: "wiki-switch" }, el("input", { type: "checkbox", checked: value || null,
          disabled: !writable || null,
          "aria-label": s.title, onchange: (e) => update(e.target.checked) }), el("span",
            { class: "wiki-switch-track" }));
      } else {
        c = el("input", { class: "layr-input wiki-text wide", value: value ?? "", disabled: !writable || null,
          spellcheck: "false",
          placeholder: "C:\\Users\\you\\Documents\\layr wiki", "aria-label": s.title });
        c.addEventListener("change", () => update(c.value.trim()));
      }
      return row(s, c, { changed: false, onReset: () => {} });
    }), writable ? null : el("p", { class: "layr-muted" }, "This panel can't change them here: ",
      el("a", { href: "#", onclick: (e) => (e.preventDefault(), openLayrSettings(app)) }, "open layr's settings"),
        "."));
  })();

  function showStatus(s) {
    if (!s) return;
    if (s.enabled === false) status.textContent = "Off.";
    else if (!s.folder) status.textContent = "Starting…";
    else {
      put(status, el("span", {}, `In ${s.folder}${s.lastRun ? ` (written ${app.ui.ago(s.lastRun)})` : ""}.`));
      if (s.error) add(status, el("div", { class: "layr-error" }, s.error));
      if (s.attachmentsError) add(status, el("div", { class: "layr-muted" }, `Attachments: ${s.attachmentsError}`));
    }
  }
  async function loadStatus() {
    try {
      const s = await app.tools("mirror_status", {});
      if (alive) showStatus(s);
    } catch (error) {
      if (!alive) return;
      status.textContent = error?.code === layr.errors?.NOT_AVAILABLE
        ? "Kept on your PC (it's offline now)." : `Not available here: ${error.message}`;
    }
  }
  loadStatus();
  return () => (alive = false);
}

function openLayrSettings(app) {
  layr.commands.run("shell.settings").catch(() => app.ui.notify("Open layr's Settings › Wiki"));
}
