// The dev page's stand-in `app` (docs/PLAN.md › The panel) and a sample page using every feature.
import { createEditor } from "./index.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { normalizeSettings, DEFAULTS } from "../../shared/settings.js";
import { splitFrontmatter } from "../../shared/frontmatter.js";

const q = new URLSearchParams(location.search);
if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");

const pages = [
  { title: "Photosynthesis", folder: "Biology", body: "# Photosynthesis\n\nLight to sugar.\n\n## Light reactions\n\nIn the **thylakoid** membranes.\n\n## Calvin cycle\n\nCarbon fixation by RuBisCO.", aliases: ["Photo"], tags: ["biology", "plants"], updated: 1 },
  { title: "Chlorophyll", folder: "Biology", body: "A green pigment.", aliases: [], tags: ["biology"], updated: 1 },
  { title: "Meeting notes", folder: "", body: "Notes.", aliases: [], tags: ["work"], updated: 1 },
  { title: "Templates/Daily", folder: "Templates", body: "## {{date}}\n\n- [ ] ", aliases: [], tags: [], updated: 1 },
].map((p, i) => ({ id: `p${i}`, type: null, markdown: p.body, ...p }));
const byKey = (t) => pages.find((p) => [p.title, ...p.aliases].some((x) => x.toLowerCase() === String(t).toLowerCase()));

const stored = { ...DEFAULTS, ...JSON.parse(q.get("settings") ?? "{}") };
const settingsListeners = new Set();
const log = [];
const note = (s) => {
  log.push(s);
  window.__log = log;
};

async function png(w, h, hue) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue} 70% 60%)`);
  grad.addColorStop(1, `hsl(${hue + 60} 70% 45%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,.85)";
  g.font = "bold 28px sans-serif";
  g.fillText("leaf.png", 20, 50);
  return (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
}

const files = [{ name: "leaf.png", mime: "image/png" }, { name: "paper.pdf", mime: "application/pdf" }];
window.app = {
  wiki: {
    live: () => pages,
    resolve: (t) => byKey(t) ?? null,
    find: (t) => byKey(t) ?? null,
    templates: () => pages.filter((p) => p.folder === "Templates"),
  },
  files: {
    list: async () => files,
    download: async (name) => {
      if (!/leaf/.test(name)) throw new Error("not found");
      return { record: files[0], bytes: await png(640, 360, 120) };
    },
    upload: async (name) => {
      files.push({ name, mime: "image/png" });
      return { name };
    },
  },
  settings: {
    all: () => normalizeSettings(stored),
    get: (id) => normalizeSettings(stored)[id],
    set(changes) {
      Object.assign(stored, changes);
      for (const fn of settingsListeners) fn(normalizeSettings(stored));
    },
    on(fn) {
      settingsListeners.add(fn);
      return () => settingsListeners.delete(fn);
    },
  },
  ui: { fail: (e) => note(`fail: ${e?.message ?? e}`), narrow: () => matchMedia("(max-width: 700px)").matches },
  openPage: (t, o) => note(`openPage ${t} ${JSON.stringify(o)}`),
  open: (r) => note(`open ${JSON.stringify(r)}`),
  openUrl: (u) => note(`openUrl ${u}`),
  markdown: (el, text) => (el.innerHTML = renderMarkdown(splitFrontmatter(text).body)),
  emit: () => {},
  on: () => () => {},
};

const SAMPLE = `---
type: Topic
tags: [biology, plants]
aliases: [Photo]
---
# Leaves and light

Plants turn **light** into *sugar*; see [[Photosynthesis]] and [[Photosynthesis#Calvin cycle|the Calvin cycle]].
A page that doesn't exist yet: [[Stomata]]. Text can be ~~struck~~, <u>underlined</u>, ==highlighted==,
<mark style="background:#0f7b6c55">highlighted in green</mark>, <span style="color:#e03e3e">red</span>,
H<sub>2</sub>O and E = mc<sup>2</sup>, with \`inline code\`, $e^{i\\pi} + 1 = 0$ and a link to [MDN](https://developer.mozilla.org). #biology #plants/leaves

## A checklist

- [ ] Order seeds
- [x] Water the basil
- A plain item
    - nested item
1. First
2. Second

> [!tip] Good to know
> Callouts take **Markdown** too.

> [!warning]
> No title: the kind shows.

> A plain quote, as people wrote it.

## A table

| Plant     | Light  | Water |
| :-------- | :----: | ----: |
| Basil     | Full   |    2× |
| Fern      | Shade  |    3× |

## Code and math

\`\`\`python
def grow(plant, days=3):
    # comment
    return plant.height * 1.1 ** days
\`\`\`

$$
\\int_0^1 x^2\\,dx = \\tfrac13
$$

---

![[leaf.png|A leaf in the sun|320]]

![[paper.pdf]]

![[Photosynthesis#Light reactions]]
`;

const ed = await createEditor(document.getElementById("host"), {
  doc: q.get("doc") ?? SAMPLE,
  app: window.app,
  page: { id: "self", title: "Leaves and light" },
  mode: q.get("mode") ?? undefined,
  onChange: (t) => (window.__text = t),
  onSave: () => note("save"),
});
ed.toolbar(document.getElementById("bar"));
ed.on("selection", (s) => (window.__sel = s));
window.ed = ed;
window.__ready = true;
