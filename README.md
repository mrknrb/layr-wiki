# Wiki

A personal knowledge base for years of work, for anyone: one page per thing (a person, a project, a book, a meeting,
an idea, a how-to), linked to each other, kept in folders, readable and writable by the AI, on the PC and the phone.

## Decisions

- **Markdown, in Obsidian's format.** Plain text lasts for decades, the AI reads and writes it best, and Obsidian,
  GitHub and pandoc all read it. A page is the Markdown of one file: optional YAML properties between `---` lines
  (`type`, `aliases`, `tags`, the type's fields), then the text. Links `[[Title]]`, `[[Title|text]]`,
  `[[Title#Heading]]`; embeds `![[picture.png]]`; callouts `> [!note]`; `==highlight==`; `%%comment%%`; `#tags`;
  `$math$` (shown as written). Titles are file names, so they can't hold `[ ] # ^ | \ / : * ? " < >`.
- **A personal Wikipedia by structure**: page types give the info box (fields, labels) and a new page's properties
  and template; "Linked from" (backlinks), "Mentioned without a link" (with Link it), wanted pages (red links), pages
  nothing links to. The wiki starts with no types: they are the user's own (data `type/<name>`: icon, colour, fields
  of the kinds text, number, date, checkbox, select, multiselect, link, url, file, and a template), made in the type
  editor or by `wiki__define_type`. A page may name a type nobody defined.
- **Folders, nested, like Obsidian; titles stay unique across the whole wiki**, so links stay `[[Title]]` and moving a
  page never breaks one. A page record's `folder` is a path (`Projects/Thesis`); empty folders are data
  `folder/<path>`. Templates are the pages in the templates folder (`{{title}}`, `{{date}}`, `{{time}}`,
  `{{date:FORMAT}}`); daily notes are made from the daily template in the daily notes folder.
- **Review mode** (setting "Review AI changes before they apply"): agents' changes wait as proposals (data
  `proposal/<id>`) until the user accepts or rejects them; accepting a text change to a page that changed since
  merges the two line by line, or says it can't when they touch the same lines.
- **Settings in the wiki** (data `settings`, synced, `shared/settings.js`), except the folder copy's two (layr
  settings, because they are about this PC).
- **Where the truth is: the plugin's synced data, plus a live folder copy.** Pages are `layr.db` records (collection
  `pages`), synced between the user's devices through Supabase (`"sync": true`, `lf_plugin_records`), so the panel
  works on the phone with no backend. On the PC the backend writes every page to `<root>/<its folder>/<Title>.md`
  (folders as folders, empty ones too) and every attachment to `<root>/attachments/` (default
  `Documents\layr wiki`): plain files Obsidian opens as a vault, git can
  track and any backup takes. The copy is written, never read back (two-way syncing breaks more easily); a file
  changed there is kept in `.layr-wiki/overwritten/` before it is replaced. Bring files in with Import a folder.
- **The AI writes directly (unless review mode is on); everything can be undone.** Every save records a revision
  (data `rev/<page id>/<stamp>`, an editing burst of one author within 10 minutes is one revision; old ones thin out
  to one a day, at most 120; all three numbers are settings). A
  change from an agent is recorded as `ai` with its Claude thread; the panel shows "Changed by AI" with See changes
  and Undo. History shows every version with a diff and Restore. Deleting is the trash (restorable); only the user can
  delete forever.
- **Attachments in Supabase Storage**: the private bucket `lf-wiki`, objects `<user id>/<sha256>`
  (`supabase/migrations/lf_0004_wiki_files.sql`, applied by the user). No core change: the plugin uses the `supabase`
  permission (the user's session). Names are data `file/<name>`.
- **Its own plugin**, separate from `notes` (quick notes stay quick).

## Pieces

- `shared/`: the model both sides run. `wiki.js` (pages, folders, history, rename that fixes links, trash, search,
  backlinks, wanted pages, types, templates, daily notes, bookmarks, proposals), `folders.js` (folder paths),
  `templates.js` (dates, placeholders, daily note titles), `proposals.js` (review mode, the three-way merge),
  `settings.js`, `frontmatter.js` (properties; changes only the lines it is asked to), `links.js`, `markdown.js` (the
  renderer), `types.js` (types, field kinds and values), `files.js` (attachments, sha256), `diff.js`.
- `panels/main.*` and `panels/app/`: the frame (the shell) and the `app` object every part is installed into
  (`docs/PLAN.md` › The panel). Tabs (each with its own back and forward, reordered by dragging, restored with the
  panel), the left sidebar (file tree with folders and drag and drop, search with `#tag`, `type:`, `folder:`, nested
  tags, bookmarks) and the right one, both resizable and hideable, focus mode, the quick switcher (Ctrl+O), the
  command palette (Ctrl+P), keys every command can be given (Settings › Keyboard shortcuts), the home page, the trash
  and the Settings page. On the phone: one column, sidebars that swipe in from the edges, a tab switcher and a + button
  for a quick note (hold it: today's note). `scripts/icons.mjs` writes `panels/app/icons.js` from lucide-static.
- `panels/page/`: one page. The page view (folder breadcrumb, title that renames with its links fixed, badges, the
  properties editor with an input for each field kind, the reading view or the editor, autosave, a change made
  elsewhere merged in or shown as a conflict, the "Changed by AI" banner, history with diffs, word count, "Linked
  from"), the right sidebar's outline, backlinks, unlinked mentions (Link it, Link all) and properties, hover
  previews, the new-page dialog with folders, types and templates, the picture lightbox (zoom, pinch, next) and PDFs
  inside pages (`vendor/pdfjs/`, pdf.js's legacy build without WebAssembly). `shared/markdown.js` renders the reading
  view: of raw HTML only `<span>` with colour or background, `<mark>` with background, `<u>`, `<sup>` and `<sub>`;
  pictures with a size and a caption (`![[pic.png|caption|400]]`), page and section embeds (3 deep, loops as links).
- `panels/editor/`: the editor (`createEditor`, its API at the top of `index.js`), CodeMirror 6 with an Obsidian-style
  live preview (the Markdown signs show only where the selection is) and a source mode: links, embeds of pictures
  (resized by dragging, captions), files and pages, checkboxes, callouts, a table editor, `$math$`, code highlighting,
  completion of `[[links]]`, headings and `#tags`, the `/` menu, colours from the palette, and the formatting toolbar
  (above the keyboard on the phone). The pure text operations are `markdown-ops.js`. `npm run build`
  (`scripts/vendor.mjs`) bundles CodeMirror and the code languages into `vendor/editor.js` (committed), which also
  exports `highlight(code, lang)` for the reading view (classes `tok-*`, coloured by `panels/editor/editor.css`).
- `panels/views/`: the views over many pages. **Database views** (route `view`, data `view/<id>`; `shared/query.js`):
  a source (folder with its subfolders, type, tag, words) plus filters (is, is not, contains, empty, >, <, before,
  after, within the last N days), multi-field sort, and a layout: table (columns chosen, reordered and resized by
  dragging, cells edited in place by their field kind), board (cards dragged between the values of a select, type,
  folder or tag), gallery (the first picture or a cover field), calendar (by a date; drag to change it), list; saved
  views are listed in the left sidebar. **Tasks** (route `tasks`; `shared/tasks.js`): every `- [ ]` across the pages,
  by due date, page or folder; checking one off rewrites just its line. Due dates are written `📅 2026-11-20`
  (`due:: 2026-11-20` is read too), priorities 🔺 ⏫ 🔼 🔽 ⏬, as Obsidian's Tasks and Dataview plugins write them.
  **Graph** (route `graph`, and a local graph in the right sidebar): canvas with its own force layout (Barnes–Hut,
  `force.js`), zoom, pan, drag, pinch on touch, filters, colour by type or folder. **Attachments**, **Health** (broken
  links, same titles or aliases, empty pages, pages without the type their folder's others share, orphans, each with a
  one-click fix), the **type editor** (route `types`) and the **calendar** (left sidebar and route `calendar`: a day
  opens its daily note). `app.views.createFor({folder, type, tag})` opens (or makes) a view of those pages.
- `backend/`: `server.js` (MCP on stdio, the hub), `core.js` (the backend without its transport), `tools.js` (the
  `wiki__*` tools and the guide agents read), `mirror.js` (the folder copy).

## AI, import, export and public links

- **AI** goes through the Claude Code plugin and **the clipper** through Web tools (`scraper__scrape`): both optional
  connections. Their buttons show only while the connection is usable. **Ask Claude** (route `ask`, also a
  right-sidebar panel) sends the message to a Claude thread that opens beside the wiki (`panels.open` thread, `right`,
  reused), so there is one kind of chat in layr and it can use every plugin. The thread works in the wiki's own folder
  (`<LAYR_DATA_DIR>/Wiki`, tool `thread_folder`, only a CLAUDE.md in it; project "Wiki") and starts locked: `dontAsk`
  with reading, the web and `mcp__layr` allowed, so it never edits files or runs programs, and layr's tools go by Tool
  access. The next message continues it (data `askThread`) until "New thread". Chats from before are data
  `ask/<id>`, readable under "Earlier chats". AI actions on selected text, Suggest links and tags (page ⋯ menu),
  the Review page for AI changes waiting in review mode, and Clip a web page (into the `clipFolder` folder, pictures
  copied as attachments on the PC). Code: `panels/ai/`.
- **Export** a page, a folder or picked pages as one HTML file (pictures and styles inside), Markdown (a .zip with
  the attachments), Word (.docx, made by the backend) or print / PDF. **Import** Word files and Notion exports
  ("Markdown & CSV" zip: Notion's ids dropped, folders kept, links as `[[links]]`, each database as one page with a
  table). Imports and Word export need the PC. Code: `panels/io/`, `backend/io-tools.js`.
- **Public links**: Publish (page ⋯ menu) puts the page, rendered, as JSON in the public Storage bucket
  `lf-wiki-shares` under a random 24-character name (`supabase/migrations/lf_0005_wiki_shares.sql`). The link opens a
  viewer page you host once: `share/index.html`, one static file with no outside loads that shows the page in a
  sandbox. Nobody finds a page without its link; Stop sharing deletes it.

### Hosting the viewer on GitHub Pages (once)

Needs git and the GitHub CLI (`gh auth login` done). Make a public repository with just the viewer and turn on Pages
(in PowerShell, from this repository's folder):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\wiki-share" | Out-Null
Copy-Item "plugins\wiki\share\index.html" "$env:USERPROFILE\wiki-share\index.html"
Set-Location "$env:USERPROFILE\wiki-share"
git init -b main
git add index.html
git commit -m "Wiki share viewer"
gh repo create wiki-share --public --source . --push
gh api -X POST "repos/{owner}/{repo}/pages" -f "source[branch]=main" -f "source[path]=/"
```

After a minute the viewer is at `https://<your GitHub name>.github.io/wiki-share/`: put that address in the wiki's
Settings › Sharing › Address of your share viewer. The viewer holds no data, so the repository can be public. Update
it by copying a newer `index.html` and pushing again.

## Tools (`wiki__*`)

| Group | Tools |
| --- | --- |
| read (plugins and agents: allowed) | `guide`, `overview`, `search`, `list`, `read`, `history`, `types`, `attachments`, `mirror_status`, `folders`, `templates`, `proposals`, `tasks`, `views`, `query`, `export` |
| write (agents: allowed) | `create`, `write`, `edit`, `append`, `set_properties`, `rename`, `move`, `trash`, `restore`, `define_type`, `delete_type`, `create_folder`, `rename_folder`, `daily_note`, `clip_page`, `mirror_now` |
| share (asks first) | `publish`, `unpublish` (anyone with the link can read the page) |
| files (agents: allowed) | `attach` (a file from the PC), `import_folder` (an Obsidian vault, its folders kept), `import_word`, `import_notion`, `upload_part`, `clip_images` |

Links for people: `layr://wiki/page/<Title>` opens the page; `layr://wiki/search/<query>` searches. layr commands
`wiki.quick-note` and `wiki.today` (File menu) open the panel with a new quick note or today's note.

## Tests

- `npm test` (or `node test/check.mjs`, the plugin's `check`): the model, the renderer, the tools, the folder copy,
  import and attachments against an in-memory store and a fake Storage.
- `node test/panel.e2e.js`: `layr serve` (core's debug build) with the plugin linked, the tools over `/mcp`, the panel
  in headless Chromium (tabs, the file tree and moving pages into folders, search, tags, bookmarks, the quick
  switcher, the command palette, rebinding a key, live settings, the trash, focus mode, tabs restored after a reload,
  an AI change arriving live, light and dark, the phone layout and quick capture), and the folder copy; screenshots in
  `screenshots/`.
- `node test/editor.e2e.js`: the editor alone (`panels/editor/dev.html`, a stand-in `app`, no layr needed) in headless
  Chromium: live preview, formatting and colours, lists, completion, the `/` menu, the table editor, checkboxes, link
  clicks, resizing a picture, paste, source mode, live settings, light and dark, PC and phone; `screenshots/editor-*`.
