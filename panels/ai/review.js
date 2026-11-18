// The review inbox (route `review`): changes AI agents made while the setting aiReview is on wait here as proposals
// (part B's model: wiki.proposals(), accept(id), reject(id)). Each shows what it would do, a diff for text changes,
// and Accept / Reject; Accept all at the top; the setting itself is switched here too. A left-sidebar entry with the
// count shows while something waits.
import { el, icon } from "../app/dom.js";
import { diffLines, diffStats, foldDiff } from "../../shared/diff.js";

const OPS = { create: "New page", save: "Change", rename: "Rename", trash: "Move to the trash", move: "Move" };

async function proposals(app) {
  try {
    return (await app.wiki.proposals?.()) ?? [];
  } catch {
    return [];
  }
}

export function diffView(before, after) {
  const ops = foldDiff(diffLines(before ?? "", after ?? ""), 2);
  const { add, del } = diffStats(ops);
  return el("div", { class: "ai-diff" },
    el("div", { class: "ai-diff-stats" }, el("span", { class: "add" }, `+${add}`), el("span", { class: "del" }, `−${del}`)),
    el("pre", { class: "ai-diff-lines" }, ops.map((o) => o.op === "skip"
      ? el("div", { class: "skip" }, `… ${o.count} unchanged line${o.count === 1 ? "" : "s"}`)
      : el("div", { class: o.op }, el("span", { class: "sign" }, o.op === "add" ? "+" : o.op === "del" ? "−" : " "),
        o.text || " "))));
}

function describe(app, p) {
  const page = p.pageId ? app.wiki.pages?.get(p.pageId) : null;
  if (p.op === "rename") return `[[${p.title}]] → ${p.newTitle}`;
  if (p.op === "move") return `${p.title} → ${p.folder ? `folder ${p.folder}` : "the top folder"}`;
  if (p.op === "trash") return p.title;
  if (p.op === "create") return `${p.folder ? `${p.folder}/` : ""}${p.title}`;
  return page?.title ?? p.title;
}

function card(app, p, refresh) {
  const page = p.pageId ? app.wiki.pages?.get(p.pageId) : null;
  const who = p.agent ? `AI (${p.agent})` : p.by === "ai" ? "AI" : String(p.by ?? "").replace(/^plugin:/, "");
  const changedSince = p.op === "save" && page && p.base != null && page.markdown !== p.base;
  const act = async (fn, button) => {
    button.disabled = true;
    try {
      const r = await fn();
      if (r?.merged) app.ui.notify("Accepted; merged with the changes made since", "success");
    } catch (error) {
      app.ui.fail(error);
    }
    refresh();
  };
  const accept = el("button", { class: "layr-button primary small" }, icon("check"), "Accept");
  accept.onclick = () => act(() => app.wiki.accept(p.id), accept);
  const reject = el("button", { class: "layr-button small" }, icon("x"), "Reject");
  reject.onclick = () => act(() => app.wiki.reject(p.id), reject);
  return el("div", { class: "ai-review-card layr-card" },
    el("div", { class: "ai-review-top" },
      el("span", { class: `layr-badge ${p.op === "trash" ? "danger" : p.op === "create" ? "success" : "accent"}` },
        OPS[p.op] ?? p.op),
      page && p.op !== "create"
        ? el("a", { class: "wl ai-review-title", href: "#", "data-page": page.title }, describe(app, p))
        : el("strong", { class: "ai-review-title" }, describe(app, p)),
      el("span", { class: "layr-spacer" }),
      el("span", { class: "layr-muted ai-small" }, `${who} · ${app.ui.ago?.(p.at) ?? ""}`)),
    p.note ? el("p", { class: "ai-review-note" }, p.note) : null,
    changedSince ? el("p", { class: "ai-review-warn" }, icon("triangle-alert"),
      "The page changed since; accepting merges the two when they touch different lines.") : null,
    p.op === "save" || p.op === "create" ? diffView(p.op === "create" ? "" : p.base ?? page?.markdown ?? "", p.markdown) : null,
    el("div", { class: "ai-review-buttons" }, reject, accept));
}

export function renderReview(app, root) {
  const view = el("div", { class: "ai-review" });
  root.replaceChildren(view);
  let alive = true;
  const draw = async () => {
    if (!alive) return;
    const list = await proposals(app);
    const on = Boolean(app.settings?.get?.("aiReview"));
    const toggle = el("input", { type: "checkbox", checked: on ? true : null, onchange: async (e) => {
      try {
        await app.settings.set({ aiReview: e.target.checked });
      } catch (error) {
        app.ui.fail(error);
      }
    } });
    const bulk = async (fn, what) => {
      if (!(await app.ui.confirm(`${what} all ${list.length} change(s)?`, { danger: what === "Reject" }))) return;
      const problems = [];
      for (const p of list) {
        try {
          await fn(p.id);
        } catch (error) {
          problems.push(`${p.title}: ${error.message}`);
        }
      }
      if (problems.length) app.ui.notify(`${problems.length} couldn't be applied: ${problems[0]}`, "error");
      draw();
    };
    view.replaceChildren(
      el("div", { class: "ai-review-head" },
        el("h2", {}, icon("inbox"), "Review AI changes", list.length ? el("span", { class: "layr-badge accent" }, String(list.length)) : null),
        el("span", { class: "layr-spacer" }),
        list.length > 1 ? el("button", { class: "layr-button", onclick: () => bulk((id) => app.wiki.reject(id), "Reject") },
          "Reject all") : null,
        list.length > 1 ? el("button", { class: "layr-button primary", onclick: () => bulk((id) => app.wiki.accept(id), "Accept") },
          icon("check-check"), "Accept all") : null),
      el("label", { class: "ai-review-toggle layr-card" }, toggle,
        el("span", {}, el("strong", {}, "Review AI changes before they apply"),
          el("span", { class: "layr-muted" }, on
            ? "On: changes AI agents make wait here until you accept or reject them."
            : "Off: AI agents change pages directly (every change can still be undone in History)."))),
      list.length
        ? el("div", { class: "ai-review-list" }, list.map((p) => card(app, p, draw)))
        : el("div", { class: "layr-empty ai-review-empty" }, icon("inbox"), el("p", {}, "Nothing to review."),
          el("p", { class: "layr-muted" }, on ? "New AI changes will appear here." : "Turn the switch on to check AI changes first.")));
  };
  const offChanged = app.on?.("changed", (d) => (d?.proposals || !d) && draw());
  const offSettings = app.on?.("settings", draw);
  draw();
  return () => {
    alive = false;
    offChanged?.();
    offSettings?.();
  };
}

export function installReview(app) {
  let count = 0;
  const recount = async () => {
    const n = (await proposals(app)).length;
    if (n !== count) {
      count = n;
      app.emit?.("review-count", n);
      app.emit?.("layout", { sidebar: "left" });
    }
  };
  app.views?.register("review", { title: "Review AI changes", icon: "inbox", render: (root) => renderReview(app, root) });
  app.commands?.register({ id: "review", title: "Review AI changes", icon: "inbox", run: () => app.open({ view: "review" }) });
  app.sidebar?.register("left", {
    id: "review", title: "Review", icon: "inbox", order: 5, when: () => count > 0,
    render(root) {
      const draw = () => root.replaceChildren(el("button", { class: "ai-review-side", onclick: () => app.open({ view: "review" }) },
        icon("inbox"), el("span", {}, `${count} AI change${count === 1 ? "" : "s"} to review`), el("span", { class: "layr-badge accent" }, String(count))));
      draw();
      return app.on?.("review-count", draw);
    },
  });
  app.on?.("changed", (d) => {
    if (!d || d.proposals || d.keys?.some?.((k) => k.startsWith("proposal/"))) recount();
  });
  recount();
}
