# Wiki 0.2: the design and the contract between its parts

0.2 made Wiki 0.1 (pages in `layr.db` collection `pages`, history in `layr.data` `rev/…`, the model `shared/wiki.js`
shared by the panel and the backend) a general, professional knowledge base (Obsidian-class) for anyone. It was built
in parts by several agents at once, each owning some files; this is what they agreed on, and still the map of how the
panel's parts talk to each other (`app`, the editor's API, the data). Code calling into another part guards it
(`app.x?.()`, dynamic `import()` with a catch), so one broken part doesn't take the panel down.

## What the user chose

1. Editing view = **live preview like Obsidian** (CodeMirror 6): formatted while you write, the Markdown signs show only
   on the line/selection you edit; plus a **source** mode (setting) and the **reading view**. Markdown stays the format.
2. Formatting: **text colour** (`<span style="color:#hex">…</span>`) and **highlights in colours**
   (`<mark style="background:#hex">…</mark>`; plain `==x==` stays the default yellow), from the palette in the settings;
   **underline** `<u>`, ~~strikethrough~~, **superscript** `<sup>`, **subscript** `<sub>`; **callouts** from a menu.
   Raw HTML stays escaped except exactly these tags with exactly these style properties (colour values: `#hex`, `rgb()`,
   `var(--name)` or a CSS colour word).
3. Images: **resize by dragging** (saved `![[pic.png|400]]`), **captions** (`![[pic.png|A caption|400]]`: the text part
   is the caption; Obsidian reads it as alt text), **full-screen view with zoom**, **PDFs inside the page**
   (`![[paper.pdf]]`, `![[paper.pdf#page=3]]`), an **attachments page** (every file, where used, unused flagged).
4. Layout: **left sidebar can be hidden** (button and Ctrl+\\) and resized; a **right sidebar** (outline, backlinks,
   unlinked mentions, properties), resizable and hideable; **tabs** for open pages; **quick switcher** (Ctrl+O),
   **command palette** (Ctrl+P); **hover preview** of links; **focus mode**. No split view.
5. **Folders**, nested, like Obsidian; a title stays unique across the whole wiki, so links stay `[[Title]]`.
6. Organising: **tags panel** (nested tags `#a/b`), **bookmarks** (pinned pages, views, searches), **templates** (pages in
   the templates folder; `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`), **daily notes + calendar**, **database
   views** (any set of pages as table / board / gallery / calendar / list, with filters, sorting, grouping).
7. Types: **start empty**; a **type editor** (name, icon, colour, fields, template); field kinds: text, number, date,
   checkbox, select, multiselect, link (to a page, optionally of a type), url, file.
8. The 12 built-in biology types are **dropped**; pages keep their `type:` line as plain text (a type in use without a
   definition shows with a default icon and "Define this type" in the type editor).
9. Links: **graph view** (whole wiki and a page's neighbourhood), **embedding a page or a section**
   (`![[Page]]`, `![[Page#Heading]]`, rendered inside, depth ≤ 3, no loops), **unlinked mentions → link in one
   click**, a **health page** (broken links, orphans, duplicate titles, empty pages).
10. Writing: **`/` menu**, **checklists + one view of all tasks**, **table editor**, **find & replace**, **word count and
    reading time**, **code highlighting**. No Mermaid, no footnotes.
11. Settings: everything in `shared/settings.js` (look, editor, hotkeys, links and files, AI, history, templates and
    daily notes, sharing); 12: a **Settings page inside the wiki** with live effect; the folder copy's two settings stay
    layr settings (`layr.json`) and show there too.
13. AI (through the Claude Code plugin's `ask` tool, an optional connection): **Ask your wiki** (a chat that answers from
    your pages and links its sources), **AI actions on selected text** (rewrite, summarize, translate, explain, fix
    spelling, continue), **suggested links and tags**, **review mode** (setting `aiReview`: agents' changes wait as
    proposals until accepted or rejected).
14. **Export** a page or several (HTML, PDF via print, Word .docx) and print; **web clipper** (a web page → a page, through
    the Web tools plugin `scraper`, optional connection); **public read-only links** (see Sharing); **import** Notion
    exports (zip or folder) and Word files. No two-way folder sync.
15. Phone: **formatting toolbar above the keyboard**, **swipe from the edge** to open the sidebars, **quick capture**
    (a new note or today's note, one tap; also layr commands).
16. The plugin stays **Wiki**; version **0.2.0**.

## Rules for everyone

- Work only in your own files (the table below). Need a change in someone else's file? Don't make it: write it in your
  final report under "Needs from others" (exactly what and why). Exception: `layr.json` and `README.md`, which several
  parts touch: edit only your own lines, re-read the file right before each edit, keep it valid JSON.
- No git commands that change anything (no commit, stash, checkout, reset). The lead commits at the end.
- npm packages are installed already (see `package.json`); don't run `npm install`. Ask for a missing one in the report.
- No CDN or internet loads: libraries are bundled into `vendor/` (layr's panel CSP allows only the plugin itself, the
  Supabase origin, `data:` and `blob:`). Panels are ES modules served from the plugin folder (`../shared/x.js` works).
- Style: 120-column lines, match the code around you, comments that say why, plain English for anything the user reads.
- Light and dark: use layr.css's variables (`var(--layr-…)`; see `core/layr_core/assets/layr.css` and the current
  `panels/main.css`). Everything must work at phone width (≤ 700 px, touch) and on the PC.
- Tests: `node --test test/*.test.js` in `plugins/wiki` must pass. Add tests for pure logic you write
  (`test/<part>.test.js`). Don't break others' tests; if a contract change forces it, say so.
- Icons: `icon("name")` from `panels/app/dom.js`, Lucide names (https://lucide.dev/icons). The shell part generates
  `panels/app/icons.js` with the whole Lucide set it may need; until then unknown names draw a circle.

## Who owns what

| Part | Owner files |
| --- | --- |
| **A. Editor** | `panels/editor/**` (incl. `editor.css`), `scripts/vendor.mjs` (esbuild), `vendor/editor.js` (built bundle, committed), package.json `scripts.build` |
| **B. Data and backend** | `shared/wiki.js`, `shared/types.js`, `shared/frontmatter.js`, `shared/links.js`, `shared/settings.js`, `shared/templates.js` (new), `shared/folders.js` (new), `shared/proposals.js` (new), `backend/tools.js`, `backend/core.js`, `backend/server.js`, `backend/mirror.js`, `test/wiki.test.js`, `test/shared.test.js`, `test/backend.test.js`, `test/memory.js`, layr.json `access` + `settings` |
| **C1. Shell** | `panels/main.html`, `panels/main.js`, `panels/main.css`, `panels/app/**` (app, tabs, sidebars, file tree, tags, bookmarks, switcher, palette, hotkeys, settings page, phone gestures, home, trash), `scripts/icons.mjs`, `test/panel.e2e.js`, layr.json `commands`/`menus`/`keybindings`/`panels`/`links` |
| **C2. Page** | `panels/page/**` (page view: reading view, edit mode hosting the editor, autosave and conflicts, AI-change banner, history, properties/infobox editing, right-sidebar panels: outline, backlinks, unlinked mentions, properties; hover preview; image lightbox; PDF embeds; new-page dialog with templates), `shared/markdown.js`, `vendor/pdfjs/**`, `test/markdown.test.js` |
| **D. Views** | `panels/views/**` (graph, database views, tasks, attachments page, health page, type editor, calendar sidebar panel), `shared/query.js` (new), `shared/tasks.js` (new), `backend/view-tools.js`, `test/views.test.js` |
| **E. AI and in/out** | `panels/ai/**` (ask, selection actions, suggestions, review inbox, clipper), `panels/io/**` (export, print, import, publish), `share/**` (the public viewer page), `backend/io-tools.js`, `supabase/migrations/lf_0005_wiki_shares.sql`, `test/io.test.js`, layr.json `connections` + `permissions` |

## Data (B owns the model; everyone reads it through `app.wiki`)

- Page record (collection `pages`): `{title, folder, markdown, by, agent?, device?, updated, trashed?}`. **`folder`**:
  `""` (top) or a path `"Projects/Thesis"` (segments are valid titles, `/` between). Parsed page (`parsePage`) gains
  `folder` and `path` (`folder/title`). Titles stay unique across folders (matched by `keyOf`).
- Empty folders: data `folder/<lowercased path>` = `{path}`. Wiki methods: `folders()` → every folder path (from pages
  and records, sorted), `createFolder(path)`, `renameFolder(from, to)` (moves pages and subfolders),
  `deleteFolder(path)` (only empty, or `{trashPages: true}`), `move(id, folder)`.
- Types: data `type/<lowercased name>` = `{name, icon (an emoji or a Lucide name), color, description, fields:
  [{key, label, kind, options?, target?}], template}`; kinds `text number date checkbox select multiselect link url
  file`; `template` is the Markdown body new pages of the type start with. `BUILT_IN_TYPES` is gone: `wiki.types()` →
  only the user's types; `wiki.typesInUse()` → `[{name, count, defined}]`; `defineType(type)`, `deleteType(name)`,
  `renameType(from, to)` (rewrites `type:` in pages).
- Templates (`shared/templates.js`): `fillTemplate(markdown, {title, date, settings})` fills `{{title}}`, `{{date}}`,
  `{{time}}`, `{{date:FORMAT}}`, `{{time:FORMAT}}`; `formatDate(date, format)` (YYYY, YY, MM, M, DD, D, ddd, dddd,
  MMM, MMMM, HH, H, mm, ss); `wiki.templates(settings)` → the pages in the templates folder. `wiki.create({title,
  folder, type, template, markdown})` uses the type's template, else the given template page.
- Daily notes: `wiki.dailyNote(date, settings)` → the page (created from the daily template in the daily folder when
  missing); `dailyTitle(date, settings)`.
- Bookmarks: data `bookmarks` = `[{kind: "page"|"view"|"search"|"folder"|"tag", target, title}]` in order. Wiki
  methods `bookmarks()`, `setBookmarks(list)` (C1 draws them).
- Saved views (D): data `view/<id>` = `{id, name, icon, source: {folder?, type?, tag?, query?}, filters: [{field, op,
  value}], sort: [{field, dir}], layout: "table"|"board"|"gallery"|"calendar"|"list", columns: [field], groupBy,
  dateField, coverField}`. D writes `shared/query.js` (`runView(wiki, view)` → rows) and stores views itself through
  `app.wiki.a` (the adapter) or methods it adds in its own module.
- Proposals (review mode, B): data `proposal/<id>` = `{id, op: "create"|"save"|"rename"|"trash"|"move", pageId,
  title, folder, markdown, base (the text it was made from), newTitle?, by, agent, at, note}`. When the setting
  `aiReview` is on, tool calls by agents (`by: "ai"`) make proposals instead of changes (the tool result says it waits
  for the user's review). Wiki methods: `proposals()`, `accept(id)` (applies; if the page changed since `base`, merges
  when the changed lines don't overlap, else fails with a clear message), `reject(id)`.
- Settings (`shared/settings.js`, exists): data `settings`; `readSettings`, `writeSettings`, `SETTINGS`, `GROUPS`.
  Everyone adds the settings they need **there** by telling B (B owns the file; the list there already covers this plan).
  History settings (`historyMinutes`, `historyRecent`, `historyMax`) drive `COALESCE_MS` / `pruneRevisions`.
- Shares (E): data `share/<page id>` = `{slug, url, at, title}`.
- Changes are announced as now: event `wiki:changed` `{ids, types?, folders?, views?, proposals?, bookmarks?}`;
  other devices' changes arrive as `layr:data.changed`.

## The panel: `app` (C1 builds it in `panels/app/app.js`; everyone else gets it in `install(app)`)

`panels/main.js` makes `app`, then imports the parts and calls their `install(app)`, each in a try/catch so one broken
part doesn't take the panel down: `./page/index.js`, `./views/index.js`, `./ai/index.js`, `./io/index.js`. The editor
is not installed: the page part imports `../editor/index.js` itself.

```js
app.wiki            // the loaded Wiki (shared/wiki.js), kept up to date with other tabs and devices
app.files           // attachments (shared/files.js Files): upload(name, data, mime), download(name), list(), …
app.settings        // .all() → normalized settings; .get(id); .set({id: value}) (synced); .on(fn) → off
app.ui              // .el, .icon, .modal(title, build(body, close)) → {close}, .prompt(title, {value, placeholder,
                    //   label}) → string|null, .confirm(text, {danger}) → bool, .menu(items, event) (layr's context
                    //   menu), .notify(text, kind), .fail(error), .ago(ms), .narrow()
app.open(route, {newTab, replace})   // route: {view, …}; see Routes. newTab also on middle-click / Ctrl+click.
app.openPage(idOrTitle, {heading, newTab, mode})   // a page, or the "missing page" view offering to create it
app.route()         // the active tab's route; app.page() → the active tab's page or null
app.refresh()       // draw the active tab again (after a change)
app.on(topic, fn) → off; app.emit(topic, data)   // topics: "changed" {ids, …} (any data change, local or remote),
                    //   "route" (the active tab changed), "settings" (settings changed), "selection" (editor)
app.views.register(name, {title, icon, render(root, route, app) → cleanup?})   // a tab's content by route.view
app.sidebar.register("left"|"right", {id, title, icon, order, render(root, app) → cleanup?, when?(app)})
app.commands.register({id, title, icon?, key? ("ctrl+shift+k"), run(app), when?(app)})   // palette + hotkeys;
                    //   users can rebind keys (settings.hotkeys[id]); app.commands.run(id), .list()
app.pageMenu.register((page, app) => [menu items])        // the page's ⋯ menu (export, publish, suggest…)
app.selectionActions.register({id, title, icon, run(editorApi, app)})  // shown on a text selection in the editor
app.newPage({title, folder, type, template})   // C2's new-page dialog (C1 calls it for "New page")
app.markdown(root, markdown, {page, depth})    // C2: render Markdown into root (reading view, embeds, previews)
app.hoverPreview(anchorEl, title)              // C2: show a page preview near a link
app.editor          // the active tab's editor API (A's) while a page is being edited, else null
app.tools(name, args)                         // the wiki backend's tools (layr.tools.run); fails on the phone
app.ai              // E: .available() → bool (Claude connected), .ask(prompt, {system, model}) → text
```

Routes (`route.view`): `home`, `page` `{id, heading?, mode?}`, `missing` `{title}`, `trash`, `settings` `{group?}`,
`search` `{query}` (C1), `graph` `{id?}`, `view` `{id}` (database view), `tasks`, `attachments`, `health`, `types`
`{name?}`, `calendar` (D), `ask`, `review` (E). Tabs keep their own back/forward history and are saved with
`layr.panel.setState` so a restored panel comes back as it was. Links in rendered pages: `a.wl[data-page]` (C1
handles clicks on them anywhere: open; Ctrl/middle click: new tab; hover: `app.hoverPreview`).

Layout (C1): toolbar (sidebar toggle, back/forward, tabs, right-sidebar toggle, ⋯); left sidebar with panels (files =
folder tree with drag and drop of pages and folders, search, tags, bookmarks, and D's calendar), a centre with the
tab, the right sidebar with C2's panels. Resizable splitters (widths in localStorage), Ctrl+\\ and Ctrl+Shift+\\ hide
them. Focus mode hides everything but the text. Phone: one column; sidebars slide in from the edges (swipe), the editor
toolbar sits above the keyboard (A provides it, C2 places it).

## The editor (A): `panels/editor/index.js`

```js
const ed = await createEditor(parent, {
  doc, app, page,               // the text; app for settings, files, wiki (link completion); the page edited
  mode: "live"|"source",        // from settings.editorMode
  onChange(text),               // every change (the page part saves with its debounce)
  onSave(),                     // Ctrl+S
  resolve(target) → {title, exists},   // link styling (missing links red)
  upload(files) → Promise<names>,      // paste/drop of files: the page part uploads, the editor inserts embeds
  readOnly,
});
ed.getText(); ed.setText(text, {keepCursor}); ed.focus(); ed.destroy();
ed.exec(cmd, arg)   // bold italic strike underline highlight(color?) color(color|null) sup sub code link heading(n)
                    // bullet numbered task quote callout(kind) table hr codeblock(lang) math image embed indent outdent
                    // undo redo find replace
ed.selection() → {from, to, text}; ed.replaceSelection(text); ed.insert(text);
ed.on("selection"|"change"|"focus"|"blur", fn) → off
ed.stats() → {words, chars, readingMinutes}
ed.toolbar(parent) → element   // the formatting toolbar (desktop strip and the phone's bar above the keyboard)
ed.scrollToHeading(text); ed.setMode("live"|"source")
```

Live preview renders: headings, bold/italic/strike/underline/highlight/colour spans, inline code, links (`[[ ]]` as
links, click opens through `app.openPage`, Ctrl+click new tab), images and PDFs (widgets; images resizable by dragging,
captions), embeds of pages (a compact rendered block via `app.markdown`), checkboxes (clickable), callouts, tables
(rendered; a table editor to add/remove/move rows and columns and edit cells), math, horizontal rules, frontmatter
(folded into a "Properties" line; C2 shows the real properties editor above). The syntax shows again on the
line/selection being edited. `[[` completes titles (and `#heading` of the target), `#` completes tags, `/` at a line
start opens the slash menu. Code blocks highlighted; the bundle also exports `highlight(code, lang) → html` for the
reading view (C2), from `vendor/editor.js`.

## Sharing (E)

Supabase Storage serves HTML as plain text, so a public link is a **static viewer page** (`share/index.html`, one file,
hosted by the user, e.g. GitHub Pages; the setting `shareViewer` holds its address) that loads the shared page as
JSON from a **public bucket** `lf-wiki-shares` (`<user id>/<slug>.json`: `{title, html, updated, images: {name:
dataUrl}}` or uploaded image objects next to it), slug random 22+ characters; only the owner can write or delete their
folder (migration `lf_0005_wiki_shares.sql`, applied by the user). Link: `<viewer>#<supabase project ref>/<user id>/<slug>`.
Unpublish deletes the object. Republish updates it. A page shows that it is public.

## The backend

Agents' tools gain what the model gains (B): `folder` on create/list/search, `move`, `folders`, `define_type` with the
new field kinds, `delete_type`, `templates`, `daily_note`, `proposals`/review mode. D adds `tasks` (list open tasks,
by page/folder/tag) and `views`/`query` (run a saved view) in `backend/view-tools.js`; E adds `import_word`,
`import_notion`, `export` (docx/html) in `backend/io-tools.js` (they are wired into `buildTools` already). The mirror
writes folders as folders. The guide (`GUIDE` in tools.js) is general (no biology), explains folders, types and review.
