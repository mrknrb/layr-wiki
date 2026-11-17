# Wiki

A personal knowledge base for years of work (built first for a biology PhD): one page per thing (a gene, a protein, a
method, a paper, an experiment, a person, an idea), linked to each other, readable and writable by the AI, on the PC
and the phone.

## Decisions (task 39)

- **Markdown, in Obsidian's format.** Plain text lasts for decades, the AI reads and writes it best, and Obsidian,
  GitHub and pandoc all read it. A page is the Markdown of one file: optional YAML properties between `---` lines
  (`type`, `aliases`, `tags`, the type's fields), then the text. Links `[[Title]]`, `[[Title|text]]`,
  `[[Title#Heading]]`; embeds `![[picture.png]]`; callouts `> [!note]`; `==highlight==`; `%%comment%%`; `#tags`;
  `$math$` (shown as written). Titles are file names, so they can't hold `[ ] # ^ | \ / : * ? " < >`.
- **A personal Wikipedia by structure**: page types give the info box (fields, labels, links to public databases by
  stable id: UniProt, NCBI Gene, DOI, PubMed, …) and a new page's sections; "Linked from" (backlinks), "Mentioned
  without a link" (with Link it), wanted pages (red links), pages nothing links to. Built-in types: Gene, Protein,
  Pathway, Organism, Method, Paper, Experiment, Reagent, Person, Hypothesis, Topic, Note; `wiki__define_type` adds or
  changes types (kept as data `type/<name>`).
- **Where the truth is: the plugin's synced data, plus a live folder copy.** Pages are `layr.db` records (collection
  `pages`), synced between the user's devices through Supabase (`"sync": true`, `lf_plugin_records`), so the panel
  works on the phone with no backend. On the PC the backend writes every page to `<folder>/<Title>.md` and every
  attachment to `<folder>/attachments/` (default `Documents\layr wiki`): plain files Obsidian opens as a vault, git can
  track and any backup takes. The copy is written, never read back (two-way syncing breaks more easily); a file
  changed there is kept in `.layr-wiki/overwritten/` before it is replaced. Bring files in with Import a folder.
- **The AI writes directly; everything can be undone.** Every save records a revision (data `rev/<page id>/<stamp>`,
  an editing burst of one author within 10 minutes is one revision; old ones thin out to one a day, at most 120). A
  change from an agent is recorded as `ai` with its Claude thread; the panel shows "Changed by AI" with See changes
  and Undo. History shows every version with a diff and Restore. Deleting is the trash (restorable); only the user can
  delete forever.
- **Attachments in Supabase Storage**: the private bucket `lf-wiki`, objects `<user id>/<sha256>`
  (`supabase/migrations/lf_0004_wiki_files.sql`, applied by the user). No core change: the plugin uses the `supabase`
  permission (the user's session). Names are data `file/<name>`.
- **Its own plugin**, separate from `notes` (quick notes stay quick).

## Pieces

- `shared/`: the model both sides run. `wiki.js` (pages, history, rename that fixes links, trash, search, backlinks,
  wanted pages), `frontmatter.js` (properties; changes only the lines it is asked to), `links.js`, `markdown.js` (the
  renderer), `types.js`, `files.js` (attachments, sha256), `diff.js`.
- `panels/main.*`: the screen. Side list (search, `#tag`, type filter, recent or A to Z), the page (info box,
  rendered text, links), the editor (Markdown with `[[` completion, a small toolbar, paste or drop pictures, live
  preview on wide screens, autosave, rename by the title), history, overview (counts, recently changed, wanted pages,
  orphans, duplicate titles, folder copy, Import a folder), trash. One column on the phone.
- `backend/`: `server.js` (MCP on stdio, the hub), `core.js` (the backend without its transport), `tools.js` (the
  `wiki__*` tools and the guide agents read), `mirror.js` (the folder copy).

## Tools (`wiki__*`)

| Group | Tools |
| --- | --- |
| read (plugins and agents: allowed) | `guide`, `overview`, `search`, `list`, `read`, `history`, `types`, `attachments`, `mirror_status` |
| write (agents: allowed) | `create`, `write`, `edit`, `append`, `set_properties`, `rename`, `trash`, `restore`, `define_type`, `mirror_now` |
| files (agents: allowed) | `attach` (a file from the PC), `import_folder` (an Obsidian vault) |

Links for people: `layr://wiki/page/<Title>` opens the page.

## Tests

- `npm test` (or `node test/check.mjs`, the plugin's `check`): the model, the renderer, the tools, the folder copy,
  import and attachments against an in-memory store and a fake Storage.
- `node test/panel.e2e.js`: `layr serve` (core's debug build) with the plugin linked, the tools over `/mcp`, the panel
  in headless Chromium (links, editing with completion, an AI change arriving live, history, overview, a new page from
  a red link, light theme, phone layout), and the folder copy; screenshots in `screenshots/`.
