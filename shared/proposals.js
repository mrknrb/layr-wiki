// Review mode (setting `aiReview`): an agent's change waits as a proposal, data `proposal/<id>` = `{id, op, pageId,
// title, folder, markdown, base, newTitle?, by, agent, at, note}`, until the user accepts or rejects it (Wiki.accept,
// Wiki.reject). `base` is the page's text the proposal was made from: when the page changed since, accepting merges
// the two changes line by line (merge3) and fails when they touch the same lines. Pure (test/shared.test.js).
import { diffLines } from "./diff.js";

export const PROPOSAL_PREFIX = "proposal/";
export const OPS = ["create", "save", "rename", "trash", "move"];
export const proposalKey = (id) => `${PROPOSAL_PREFIX}${id}`;

/** A new proposal id: the time in base 36 (sorts as text) and some randomness. */
export const proposalId = (at) =>
  `${Math.floor(at).toString(36).padStart(9, "0")}-${Math.random().toString(36).slice(2, 8)}`;

/** One line for people and agents: what the proposal would do. */
export function describeProposal(p) {
  const page = `[[${p.title}]]`;
  switch (p.op) {
    case "create":
      return `create ${page}${p.folder ? ` in ${p.folder}` : ""}`;
    case "save":
      return `change ${page}`;
    case "rename":
      return `rename ${page} to [[${p.newTitle}]]`;
    case "trash":
      return `move ${page} to the trash`;
    case "move":
      return `move ${page} to ${p.folder ? `the folder ${p.folder}` : "the top folder"}`;
    default:
      return `${p.op} ${page}`;
  }
}

/** The changes from `base` to `text` as hunks: `{start, end, lines}` (base lines start..end-1 become `lines`). */
export function hunks(base, text) {
  const out = [];
  let i = 0;
  let cur = null;
  for (const op of diffLines(base, text)) {
    if (op.op === "same") {
      if (cur) out.push(cur);
      cur = null;
      i++;
      continue;
    }
    cur ??= { start: i, end: i, lines: [] };
    if (op.op === "del") {
      i++;
      cur.end = i;
    } else cur.lines.push(op.text);
  }
  if (cur) out.push(cur);
  return out;
}

const sameHunk = (a, b) => a.start === b.start && a.end === b.end && a.lines.join("\n") === b.lines.join("\n");

/** Do two hunks (one from each side) touch the same lines of the base? */
function overlap(a, b) {
  if (sameHunk(a, b)) return false;
  const insA = a.start === a.end;
  const insB = b.start === b.end;
  if (insA && insB) return a.start === b.start;
  if (insA) return a.start > b.start && a.start < b.end;
  if (insB) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/**
 * A line-based three-way merge: both sides' changes to `base` together. `{ok: true, text}`, or `{ok: false,
 * conflicts: [{line}]}` (1-based lines of the base) when both changed the same lines differently.
 */
export function merge3(base, ours, theirs) {
  const b = String(base ?? "").replace(/\r\n?/g, "\n");
  const x = String(ours ?? "").replace(/\r\n?/g, "\n");
  const y = String(theirs ?? "").replace(/\r\n?/g, "\n");
  if (x === y) return { ok: true, text: x };
  if (x === b) return { ok: true, text: y };
  if (y === b) return { ok: true, text: x };
  const left = hunks(b, x);
  const right = hunks(b, y);
  const conflicts = [];
  for (const h of left) {
    for (const g of right) if (overlap(h, g)) conflicts.push({ line: Math.min(h.start, g.start) + 1 });
  }
  if (conflicts.length) return { ok: false, conflicts };
  const all = [...left];
  for (const g of right) if (!left.some((h) => sameHunk(h, g))) all.push(g);
  // Insertions before a replaced range at the same place, so the order is stable.
  all.sort((p, q) => p.start - q.start || (p.end - p.start) - (q.end - q.start));
  const lines = b.split("\n");
  const out = [];
  let at = 0;
  for (const h of all) {
    out.push(...lines.slice(at, h.start), ...h.lines);
    at = Math.max(at, h.end);
  }
  out.push(...lines.slice(at));
  return { ok: true, text: out.join("\n") };
}
