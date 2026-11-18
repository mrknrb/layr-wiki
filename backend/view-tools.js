// Tools for the wiki's views: tasks across pages and saved views (database views) over pages and their properties.
// Added to buildTools (tools.js) with its helpers: ctx = {add(name, description, inputSchema, handler), S, getWiki,
// files, mirror, fs}.
import { describeSource, fieldInfo, fieldsOf, findView, listViews, normalizeView, OPS, runView,
  sourcePages, tableText } from "../shared/query.js";
import { allTasks, groupTasks } from "../shared/tasks.js";

/** Tools here that only read. */
export const VIEW_READS = ["tasks", "views", "query"];

const SOURCE = {
  type: "object",
  description: "Which pages: all of them narrowed by any of folder (with its subfolders), type, tag, query (words)",
  properties: {
    folder: { type: "string" }, type: { type: "string" }, tag: { type: "string" }, query: { type: "string" },
  },
  additionalProperties: false,
};
const FILTERS = {
  type: "array",
  description: "Each row must pass all: field (title, folder, type, tags, created, updated, links, backlinks, or a " +
    `property key), op (${OPS.map((o) => o.op).join(", ")}; within = in the last N days), value (dates YYYY-MM-DD, ` +
    "today, +7 or -7 days from today)",
  items: {
    type: "object",
    properties: { field: { type: "string" }, op: { type: "string" }, value: {} },
    required: ["field"],
  },
};
const SORT = {
  type: "array",
  description: "Sort by these fields in turn",
  items: { type: "object", properties: { field: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } },
    required: ["field"] },
};

const filterText = (f) => `${f.field} ${f.op}${f.value !== "" && f.value !== undefined ? ` ${JSON.stringify(f.value)}` : ""}`;

export function buildViewTools({ add, S, getWiki }) {
  add("tasks",
    "Checklist items (- [ ] …) across the wiki, grouped by page, with their due dates (📅 YYYY-MM-DD) and line " +
      "numbers. Open ones by default. To check one off, edit its line with wiki__edit ([ ] → [x]).",
    S({
      folder: { type: "string", description: "Only pages in this folder (and its subfolders)" },
      tag: { type: "string", description: "Only pages (or tasks) with this tag" },
      page: { type: "string", description: "Only this page (title or alias)" },
      due: { type: "string", description: "overdue, today (and overdue), week (the next 7 days and overdue), any, " +
        "none, or a date YYYY-MM-DD (due on or before it)" },
      status: { type: "string", enum: ["open", "done", "all"], description: "Default open" },
      search: { type: "string", description: "Words in the task's text or its page's title" },
      limit: { type: "integer", minimum: 1, maximum: 2000, description: "At most this many tasks (default 300)" },
    }), async ({ folder, tag, page, due, status = "open", search = "", limit = 300 }) => {
      const wiki = await getWiki();
      if (page) wiki.need(page);
      const tasks = allTasks(wiki, { folder, tag, page, due, status, search });
      if (!tasks.length) return `No ${status === "all" ? "" : `${status} `}tasks${folder ? ` in ${folder}` : ""}.`;
      const shown = tasks.slice(0, limit);
      const lines = [`${tasks.length} ${status === "all" ? "" : `${status} `}tasks`];
      for (const g of groupTasks(shown, "page")) {
        const p = g.tasks[0].page;
        lines.push("", `[[${p.title}]]${p.folder ? ` (${p.folder})` : ""}`);
        for (const t of g.tasks) {
          lines.push(`${"  ".repeat(t.depth)}- [${t.done ? "x" : t.cancelled ? "-" : " "}] ${t.label}` +
            `${t.due ? ` · due ${t.due}` : ""}${t.priority ? ` · ${t.priority}` : ""} (line ${t.line + 1})`);
        }
      }
      if (tasks.length > limit) lines.push("", `(${tasks.length - limit} more: raise limit or narrow it down)`);
      return lines.join("\n");
    });

  add("views",
    "The user's saved database views (a set of pages shown as a table, board, gallery, calendar or list), with what " +
      "each takes and how many pages it has. wiki__query runs one.",
    S({}), async () => {
      const wiki = await getWiki();
      const views = await listViews(wiki.a);
      if (!views.length) return "No saved views yet. wiki__query runs an ad-hoc one (source, filters, sort, columns).";
      return views.map((v) => {
        const n = runView(wiki, v).length;
        return [`- ${v.name} (id ${v.id}, ${v.layout}, ${n} pages): ${describeSource(v.source)}`,
          ...(v.filters.length ? [`  filters: ${v.filters.map(filterText).join("; ")}`] : []),
          ...(v.sort.length ? [`  sort: ${v.sort.map((s) => `${s.field} ${s.dir}`).join(", ")}`] : []),
          `  columns: ${v.columns.join(", ")}${v.groupBy ? ` · grouped by ${v.groupBy}` : ""}`].join("\n");
      }).join("\n");
    });

  add("query",
    "Pages as a table: a saved view (view: its name or id) or an ad-hoc one (source, filters, sort, columns). " +
      "Columns are fields: title, folder, type, tags, created, updated, links, backlinks, or property keys. Without " +
      "columns: the view's, else title, type and the properties the pages have.",
    S({
      view: { type: "string", description: "A saved view's name or id (wiki__views lists them)" },
      source: SOURCE,
      filters: FILTERS,
      sort: SORT,
      columns: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 2000, description: "At most this many rows (default 200)" },
    }), async ({ view: name, source, filters, sort, columns, limit = 200 }) => {
      const wiki = await getWiki();
      let view;
      if (name) {
        view = await findView(wiki.a, name);
        if (!view) {
          const all = await listViews(wiki.a);
          throw new Error(`No view "${name}".${all.length ? ` Saved views: ${all.map((v) => v.name).join(", ")}` : ""}`);
        }
      } else view = normalizeView({ name: "Query", source, layout: "table" });
      if (source) view.source = normalizeView({ source }).source;
      if (filters) view.filters = [...(name ? view.filters : []), ...normalizeView({ filters }).filters];
      if (sort) view.sort = normalizeView({ sort }).sort;
      const fields = fieldsOf(wiki, sourcePages(wiki, view.source), { typeName: view.source.type });
      const pages = runView(wiki, view, { fields });
      let cols = columns?.length ? columns : name ? view.columns : null;
      if (!cols) {
        const used = fields.filter((f) => !f.builtIn && pages.some((p) => p.props?.[f.key.replace(/^prop:/, "")] !== undefined));
        cols = ["title", ...(view.source.type ? [] : ["type"]), ...used.slice(0, 8).map((f) => f.key)];
      }
      const unknown = cols.filter((c) => !fields.some((f) => f.key === c));
      const head = [`${view.name === "Query" && !name ? "Query" : view.name}: ${describeSource(view.source)}` +
        `${view.filters.length ? ` · ${view.filters.map(filterText).join("; ")}` : ""} → ${pages.length} pages`];
      if (unknown.length) head.push(`(no page has ${unknown.map((c) => fieldInfo(fields, c).label).join(", ")})`);
      if (!pages.length) return head.join("\n");
      return [...head, "", tableText(wiki, pages, cols, fields, { limit })].join("\n");
    });
}
