// The wiki's own settings: one synced object in the plugin's data (key `settings`), the same on every device, shown
// on the panel's Settings page (grouped as SETTINGS says). Only the folder copy's two settings are layr settings
// (layr.json), because they are about this PC. The backend reads the same key (history, AI review). Pure; the panel
// and the backend wrap it.

export const SETTINGS_KEY = "settings";

/** The default palette for text colour and highlights (Obsidian shows `<span style="color:…">` the same way). */
export const DEFAULT_COLORS = [
  { name: "Red", color: "#e03e3e" },
  { name: "Orange", color: "#d9730d" },
  { name: "Yellow", color: "#dfab01" },
  { name: "Green", color: "#0f7b6c" },
  { name: "Blue", color: "#0b6e99" },
  { name: "Purple", color: "#6940a5" },
  { name: "Pink", color: "#ad1a72" },
  { name: "Grey", color: "#9b9a97" },
];

export const GROUPS = [
  { id: "look", title: "Look", icon: "palette" },
  { id: "editor", title: "Editor", icon: "edit" },
  { id: "links", title: "Links and files", icon: "link" },
  { id: "templates", title: "Templates and daily notes", icon: "event_note" },
  { id: "hotkeys", title: "Keyboard shortcuts", icon: "keyboard" },
  { id: "ai", title: "AI", icon: "auto_awesome" },
  { id: "history", title: "History", icon: "history" },
  { id: "sharing", title: "Sharing", icon: "public" },
];

/**
 * Every setting: `{id, group, type, title, description?, default, options?, min?, max?, step?}`. Types: boolean,
 * number, enum (options: [{value, label}]), string, color, colors (a palette), hotkeys (the hotkeys page).
 */
export const SETTINGS = [
  // Look
  { id: "theme", group: "look", type: "enum", title: "Theme", default: "layr",
    options: [{ value: "layr", label: "Same as layr" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }] },
  { id: "accent", group: "look", type: "color", title: "Accent colour", description: "Empty: layr's.", default: "" },
  { id: "font", group: "look", type: "enum", title: "Text font", default: "sans",
    options: [{ value: "sans", label: "Sans serif" }, { value: "serif", label: "Serif" },
      { value: "mono", label: "Monospace" }, { value: "system", label: "System UI" }] },
  { id: "fontSize", group: "look", type: "number", title: "Text size", default: 16, min: 12, max: 24, step: 1 },
  { id: "lineWidth", group: "look", type: "enum", title: "Line width", default: "normal",
    options: [{ value: "narrow", label: "Narrow" }, { value: "normal", label: "Normal" }, { value: "wide", label: "Wide" },
      { value: "full", label: "Full width" }] },
  { id: "density", group: "look", type: "enum", title: "Density", default: "normal",
    options: [{ value: "compact", label: "Compact" }, { value: "normal", label: "Normal" }, { value: "roomy", label: "Roomy" }] },
  { id: "pageIcons", group: "look", type: "boolean", title: "Show page icons in lists", default: true },
  { id: "colors", group: "look", type: "colors", title: "Text and highlight colours", default: DEFAULT_COLORS },

  // Editor
  { id: "defaultMode", group: "editor", type: "enum", title: "Pages open in", default: "read",
    options: [{ value: "read", label: "Reading view" }, { value: "edit", label: "Editing view" }] },
  { id: "editorMode", group: "editor", type: "enum", title: "Editing view shows", default: "live",
    options: [{ value: "live", label: "Live preview (formatted)" }, { value: "source", label: "Source (plain Markdown)" }] },
  { id: "spellcheck", group: "editor", type: "boolean", title: "Spell check", default: true },
  { id: "autosaveMs", group: "editor", type: "number", title: "Save after typing stops (ms)", default: 800, min: 200,
    max: 10000, step: 100 },
  { id: "smartLists", group: "editor", type: "boolean", title: "Smart lists",
    description: "Enter continues a list or checklist; Tab indents it.", default: true },
  { id: "autoPair", group: "editor", type: "boolean", title: "Close brackets and quotes", default: true },
  { id: "lineNumbers", group: "editor", type: "boolean", title: "Line numbers", default: false },
  { id: "tabSize", group: "editor", type: "number", title: "Tab size", default: 4, min: 2, max: 8, step: 1 },
  { id: "wordCount", group: "editor", type: "boolean", title: "Show word count", default: true },
  { id: "slashMenu", group: "editor", type: "boolean", title: "“/” menu at the start of a line", default: true },

  // Links and files
  { id: "newPageFolder", group: "links", type: "enum", title: "New pages go in", default: "current",
    options: [{ value: "current", label: "The folder of the open page" }, { value: "root", label: "The top folder" }] },
  { id: "hoverPreview", group: "links", type: "boolean", title: "Preview a page when hovering over a link", default: true },
  { id: "imageWidth", group: "links", type: "number", title: "Largest width of a new image (px, 0: no limit)",
    default: 0, min: 0, max: 4000, step: 50 },
  { id: "captions", group: "links", type: "boolean", title: "Show image descriptions as captions", default: true },
  { id: "confirmDelete", group: "links", type: "boolean", title: "Ask before moving a page to the trash", default: true },
  { id: "pdfInline", group: "links", type: "boolean", title: "Show embedded PDFs inside the page", default: true },

  // Templates and daily notes
  { id: "templatesFolder", group: "templates", type: "string", title: "Templates folder", default: "Templates" },
  { id: "dateFormat", group: "templates", type: "string", title: "Date format for {{date}}", default: "YYYY-MM-DD" },
  { id: "timeFormat", group: "templates", type: "string", title: "Time format for {{time}}", default: "HH:mm" },
  { id: "dailyFolder", group: "templates", type: "string", title: "Daily notes folder", default: "Daily" },
  { id: "dailyFormat", group: "templates", type: "string", title: "Daily note title", default: "YYYY-MM-DD" },
  { id: "dailyTemplate", group: "templates", type: "string", title: "Daily note template (a page title)", default: "" },
  { id: "openDaily", group: "templates", type: "boolean", title: "Open today's note when the wiki opens", default: false },

  // Keyboard shortcuts: {command id: "ctrl+shift+k" | ""}; missing ids use the command's own default.
  { id: "hotkeys", group: "hotkeys", type: "hotkeys", title: "Keyboard shortcuts", default: {} },

  // AI
  { id: "aiReview", group: "ai", type: "boolean", title: "Review AI changes before they apply",
    description: "Changes AI agents make wait in Review until you accept or reject them.", default: false },
  { id: "aiActions", group: "ai", type: "boolean", title: "AI actions on selected text", default: true },
  { id: "aiSuggest", group: "ai", type: "boolean", title: "Suggest links and tags", default: true },
  { id: "aiModel", group: "ai", type: "enum", title: "Model for AI actions and suggestions", default: "sonnet",
    options: [{ value: "haiku", label: "Haiku (fast)" }, { value: "sonnet", label: "Sonnet" }, { value: "opus", label: "Opus (best)" }] },

  // History
  { id: "historyMinutes", group: "history", type: "number", title: "One version per … minutes of editing", default: 10,
    min: 1, max: 120, step: 1 },
  { id: "historyRecent", group: "history", type: "number", title: "Versions kept in full", default: 40, min: 5,
    max: 500, step: 5 },
  { id: "historyMax", group: "history", type: "number", title: "Most versions kept per page", default: 120, min: 10,
    max: 2000, step: 10, description: "Older ones thin out to one a day." },

  // Sharing
  { id: "shareViewer", group: "sharing", type: "string", title: "Address of your share viewer",
    description: "Where the page viewer for public links is hosted (see the wiki's README).", default: "" },
  { id: "clipFolder", group: "sharing", type: "string", title: "Folder for clipped web pages", default: "Clippings" },
];

export const DEFAULTS = Object.fromEntries(SETTINGS.map((s) => [s.id, s.default]));

/** Stored settings (any shape) → every setting, defaults filled in and values checked. */
export function normalizeSettings(stored) {
  const out = {};
  const src = stored && typeof stored === "object" ? stored : {};
  for (const s of SETTINGS) {
    let v = src[s.id];
    if (v === undefined || v === null) v = s.default;
    else if (s.type === "boolean") v = Boolean(v);
    else if (s.type === "number") {
      v = Number(v);
      if (!Number.isFinite(v)) v = s.default;
      if (s.min !== undefined) v = Math.max(s.min, v);
      if (s.max !== undefined) v = Math.min(s.max, v);
    } else if (s.type === "enum" && !s.options.some((o) => o.value === v)) v = s.default;
    else if ((s.type === "string" || s.type === "color") && typeof v !== "string") v = s.default;
    else if (s.type === "colors" && !(Array.isArray(v) && v.every((c) => c && typeof c.color === "string"))) v = s.default;
    else if (s.type === "hotkeys" && (typeof v !== "object" || Array.isArray(v))) v = s.default;
    out[s.id] = v;
  }
  return out;
}

/** The settings from the plugin's data (adapter: dataGet). */
export async function readSettings(adapter) {
  try {
    return normalizeSettings(await adapter.dataGet(SETTINGS_KEY));
  } catch {
    return normalizeSettings(null);
  }
}

/** Change some settings: only the ones given; `null` puts a setting back to its default. */
export async function writeSettings(adapter, changes) {
  const stored = (await adapter.dataGet(SETTINGS_KEY).catch(() => null)) ?? {};
  const next = { ...stored };
  for (const [k, v] of Object.entries(changes ?? {})) {
    if (!SETTINGS.some((s) => s.id === k)) throw new Error(`No setting ${k}`);
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  await adapter.dataSet(SETTINGS_KEY, next);
  return normalizeSettings(next);
}
