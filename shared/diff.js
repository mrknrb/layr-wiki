// A line diff between two versions of a page, for History: `[{op: "same" | "add" | "del", text}]`. Longest common
// subsequence over lines after cutting off what both share at the start and end; pages are small, and a very large
// change falls back to "all removed, all added". Pure (tested in test/diff.test.js).

const MAX_CELLS = 4_000_000;

export function diffLines(before, after) {
  const a = String(before ?? "").replace(/\r\n?/g, "\n").split("\n");
  const b = String(after ?? "").replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ op: "same", text }));
  const tail = a.slice(endA).map((text) => ({ op: "same", text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  let middle;
  if (x.length * y.length > MAX_CELLS) {
    middle = [...x.map((text) => ({ op: "del", text })), ...y.map((text) => ({ op: "add", text }))];
  } else {
    const n = x.length;
    const m = y.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        middle.push({ op: "same", text: x[i] });
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) middle.push({ op: "del", text: x[i++] });
      else middle.push({ op: "add", text: y[j++] });
    }
    while (i < n) middle.push({ op: "del", text: x[i++] });
    while (j < m) middle.push({ op: "add", text: y[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** How many lines were added and removed. */
export function diffStats(ops) {
  let add = 0;
  let del = 0;
  for (const o of ops) {
    if (o.op === "add") add++;
    else if (o.op === "del") del++;
  }
  return { add, del };
}

/** The diff with unchanged runs longer than `context * 2` lines folded into `{op: "skip", count}`. */
export function foldDiff(ops, context = 3) {
  const out = [];
  let run = [];
  const flush = (atEnd) => {
    if (!run.length) return;
    const keepHead = out.length ? context : 0;
    const keepTail = atEnd ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      out.push({ op: "skip", count: run.length - keepHead - keepTail });
      out.push(...run.slice(run.length - keepTail));
    } else out.push(...run);
    run = [];
  };
  for (const o of ops) {
    if (o.op === "same") run.push(o);
    else {
      flush(false);
      out.push(o);
    }
  }
  flush(true);
  return out;
}
