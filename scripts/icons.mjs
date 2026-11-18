// Writes panels/app/icons.js: the Lucide icons the panel uses (name → the SVG's inner elements), taken from
// node_modules/lucide-static so the panel needs no icon font or CDN. Run `node scripts/icons.mjs` after adding a name.
// Unknown names are reported (exit code 1), so a typo shows here and not as a circle in the panel.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lucide = join(root, "node_modules", "lucide-static");

// Grouped only to make the list easy to read; every part of the panel may use any of them.
const NAMES = `
  file file-text file-plus file-minus file-x file-check file-search file-code file-image file-type file-question-mark
  file-pen files file-input file-output file-archive file-spreadsheet file-down file-up file-clock sticky-note notebook
  notebook-pen notebook-text book book-open book-marked library scroll-text newspaper
  folder folder-open folder-plus folder-minus folder-closed folder-tree folder-input folder-output folder-pen
  folder-search folder-x folders archive inbox package
  pencil pencil-line pen-line square-pen eraser highlighter brush paintbrush palette pipette type baseline
  bold italic underline strikethrough superscript subscript code code-xml braces brackets quote heading heading-1
  heading-2 heading-3 heading-4 heading-5 heading-6 pilcrow text text-cursor-input text-quote text-select whole-word
  wrap-text remove-formatting list list-ordered list-checks list-todo list-tree list-plus list-filter list-collapse
  indent-increase indent-decrease align-left align-center align-right align-justify minus separator-horizontal
  sigma square-function calculator omega
  check check-check square-check square-check-big square circle circle-check circle-check-big circle-dot circle-x
  circle-alert circle-question-mark circle-plus circle-minus circle-slash x plus info triangle-alert octagon-alert ban
  lightbulb bell bell-off flag flame star star-off heart thumbs-up thumbs-down
  arrow-left arrow-right arrow-up arrow-down arrow-up-right arrow-down-up arrow-left-right arrow-up-down
  arrow-right-left arrow-big-up corner-down-left corner-up-left corner-down-right move move-right undo undo-2 redo
  redo-2 rotate-ccw rotate-cw refresh-cw refresh-ccw repeat shuffle chevron-left chevron-right chevron-up chevron-down
  chevrons-left chevrons-right chevrons-up-down chevrons-down-up chevron-first chevron-last grip-vertical
  grip-horizontal grip ellipsis ellipsis-vertical menu
  panel-left panel-right panel-left-close panel-left-open panel-right-close panel-right-open panel-top panel-bottom
  layout-dashboard layout-grid layout-list layout-template layout-panel-left columns-2 columns-3 rows-3
  maximize maximize-2 minimize minimize-2 expand shrink fullscreen focus scan app-window
  table table-2 table-properties sheet kanban square-kanban gallery-horizontal gallery-vertical-end grid-3x3
  chart-bar chart-line chart-pie chart-network network git-branch git-fork waypoints workflow share-2 orbit
  image image-plus images camera film video music file-audio paperclip link link-2 unlink external-link anchor
  globe earth globe-lock share upload download cloud cloud-upload cloud-download cloud-off printer send mail at-sign
  rss qr-code
  search search-x search-check scan-search funnel sliders-horizontal settings settings-2 cog wrench hammer
  tag tags hash bookmark bookmark-plus bookmark-minus bookmark-check pin pin-off map-pin
  calendar calendar-days calendar-plus calendar-check calendar-range calendar-clock clock clock-3 timer alarm-clock
  history hourglass sun moon sun-moon contrast
  trash trash-2 copy clipboard clipboard-copy clipboard-paste clipboard-check clipboard-list scissors save
  save-all import log-in log-out lock lock-open key shield shield-check eye eye-off
  sparkles sparkle wand wand-sparkles bot brain message-square message-square-text message-circle messages-square
  languages spell-check spell-check-2 audio-lines mic
  user users user-round house building building-2 graduation-cap briefcase flask-conical microscope atom dna
  leaf sprout compass target trophy gift coffee
  keyboard command option mouse-pointer mouse-pointer-click hand monitor smartphone tablet laptop zap power plug
  activity gauge stethoscope bug terminal database server hard-drive cpu box boxes layers layers-2 blocks shapes puzzle
  smile frown meh circle-user-round badge-check badge-info badge-alert
  square-plus square-minus square-dashed square-arrow-out-up-right text-search replace replace-all regex
  case-sensitive locate locate-fixed navigation route milestone signpost
  rocket gem crown medal party-popper construction
  image-off circle-chevron-down link-2-off calendar-minus chevrons-up chevrons-down check-square zoom-in zoom-out
`.trim().split(/\s+/);

// Names the rest of the code (and the settings' GROUPS, written with Material icon names) may still use.
const ALIASES = {
  edit: "pencil", auto_awesome: "sparkles", event_note: "calendar-days", public: "globe",
  open_in_new: "external-link", data_array: "brackets", menu_book: "book-open", close: "x", add: "plus",
  more: "ellipsis", more_vert: "ellipsis-vertical", restore: "rotate-ccw", home: "house", page: "file-text",
  note: "sticky-note", ai: "sparkles", graph: "waypoints", board: "square-kanban", gallery: "gallery-vertical-end",
  today: "calendar-check", review: "clipboard-check", ask: "message-square-text", clipper: "scissors",
  health: "activity", attachment: "paperclip", view: "table-2", tasks: "list-todo", filter: "funnel",
  sidebar: "panel-left", bookmarks: "bookmark", unlock: "lock-open", "file-question": "file-question-mark",
  "circle-help": "circle-question-mark", "help-circle": "circle-question-mark", "globe-2": "earth",
  "plus-square": "square-plus", "minus-square": "square-minus",
  // Material names layr's context menus use (the panel's own menu draws them with these).
  delete: "trash-2", drive_file_move: "folder-input", note_add: "file-plus", create_new_folder: "folder-plus",
  account_tree: "folder-tree", tab_close: "x", content_copy: "copy", arrow_forward: "arrow-right",
  arrow_upward: "arrow-up", arrow_downward: "arrow-down", delete_forever: "trash-2", bookmark_add: "bookmark-plus",
  bookmark_remove: "bookmark-minus", drive_file_rename_outline: "pencil", label: "tag", star_outline: "star",
};

const version = JSON.parse(readFileSync(join(lucide, "package.json"), "utf8")).version;
// The SVG files, not icon-nodes.json: the files also hold the old names Lucide keeps as aliases (bold, history, …).
const svg = (name) => {
  try {
    return readFileSync(join(lucide, "icons", `${name}.svg`), "utf8");
  } catch {
    return null;
  }
};
const inner = (name) => svg(name).replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "")
  .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join("").replace(/\s*\/>/g, "/>");
const nodes = new Proxy({}, { get: (_, name) => (typeof name === "string" && svg(name) !== null ? true : undefined) });

const missing = [...new Set(NAMES)].filter((n) => !nodes[n]);
// A name Lucide dropped or renamed: say so, but write the rest so the panel still works while it is fixed.
if (missing.length) console.error(`Not in lucide-static ${version}: ${missing.join(", ")}`);
const names = [...new Set(NAMES)].filter((n) => nodes[n]).sort();
const lines = names.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(inner(n))},`);
for (const [alias, to] of Object.entries(ALIASES)) {
  if (!nodes[to]) console.error(`Alias ${alias} → ${to}: not in lucide-static`);
  else if (!names.includes(alias)) lines.push(`  ${JSON.stringify(alias)}: ${JSON.stringify(inner(to))},`);
}
const license = readFileSync(join(lucide, "LICENSE"), "utf8").split("\n---")[0].trim().split(/\r?\n/)
  .map((l) => `// ${l}`.trimEnd());
const out = [
  `// Lucide icons (https://lucide.dev), lucide-static ${version}: name → the SVG's inner elements.`,
  "// Generated by scripts/icons.mjs (node scripts/icons.mjs); don't edit by hand.",
  "//",
  ...license,
  "",
  "export const ICONS = {",
  ...lines,
  "};",
  "",
].join("\n");
writeFileSync(join(root, "panels", "app", "icons.js"), out);
console.log(`panels/app/icons.js: ${lines.length} icons`);
if (missing.length) process.exitCode = 1;
