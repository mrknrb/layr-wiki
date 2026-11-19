// Ask Claude: the threads' folder (backend/threads.js), the message a thread gets (panels/ai/prompts.js), and when the
// wiki may start threads (panels/ai/client.js connectionUsable), without layr running.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBackend } from "../backend/core.js";
import { READS } from "../backend/tools.js";
import { ensureThreadFolder, THREAD_INSTRUCTIONS } from "../backend/threads.js";
import { connectionUsable, THREAD_TOOLS } from "../panels/ai/client.js";
import { threadMessage } from "../panels/ai/prompts.js";
import { memoryAdapter } from "./memory.js";

test("the threads' folder is made with its CLAUDE.md, and an old CLAUDE.md is brought up to date", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "wiki-threads-"));
  try {
    const dir = await ensureThreadFolder(data);
    assert.equal(dir, path.join(data, "Wiki"));
    assert.equal(await readFile(path.join(dir, "CLAUDE.md"), "utf8"), THREAD_INSTRUCTIONS);
    await writeFile(path.join(dir, "CLAUDE.md"), "old", "utf8");
    assert.equal(await ensureThreadFolder(data), dir);
    assert.equal(await readFile(path.join(dir, "CLAUDE.md"), "utf8"), THREAD_INSTRUCTIONS);
    await assert.rejects(() => ensureThreadFolder(null), /LAYR_DATA_DIR/);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("the thread_folder tool gives the folder and only reads (no folder copy run)", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "wiki-threads-"));
  try {
    const backend = createBackend({ adapter: memoryAdapter(), session: async () => null,
      settings: async () => ({ mirror: false }), dataDir: data });
    const result = JSON.parse(await backend.call("thread_folder", {}));
    assert.equal(result.path, path.join(data, "Wiki"));
    assert.ok(READS.has("thread_folder"));
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("a thread's message names the open page with its link", () => {
  assert.equal(threadMessage("  Hi  "), "Hi");
  const m = threadMessage("Summarize it", { page: { id: "p1", title: 'The "big" one' } });
  assert.equal(m, "(Sent from the Wiki. Open page: \"The 'big' one\", layr://wiki/page/p1)\n\nSummarize it");
});

test("threads may read and call layr's tools, never edit files or run programs", () => {
  assert.ok(THREAD_TOOLS.includes("mcp__layr"));
  for (const t of ["Edit", "Write", "Bash", "NotebookEdit", "PowerShell"]) assert.ok(!THREAD_TOOLS.includes(t), t);
});

test("connectionUsable: per group, asked or allowed is usable, denied or missing is not", () => {
  const c = (groups, more = {}) => ({ plugin: "claude", installed: true, blocked: false, state: "ungranted", groups, ...more });
  const g = (id, rule) => ({ id, rule, exists: true });
  const both = c([g("ask", "allow"), g("run", "ask"), g("read", "allow")]);
  assert.equal(connectionUsable(both, ["ask"]), true);
  assert.equal(connectionUsable(both, ["run", "read"]), true);
  const denied = c([g("ask", "allow"), g("run", "deny"), g("read", "allow")]);
  assert.equal(connectionUsable(denied, ["ask"]), true, "a denied run leaves the AI actions on");
  assert.equal(connectionUsable(denied, ["run", "read"]), false);
  assert.equal(connectionUsable(c([g("ask", "allow")]), ["run", "read"]), false, "an old manifest without run");
  assert.equal(connectionUsable(c([g("ask", "allow")], { installed: false, state: "missing" }), ["ask"]), false);
  assert.equal(connectionUsable(c([g("ask", "allow")], { blocked: true }), ["ask"]), false);
  assert.equal(connectionUsable(c([{ id: "run", rule: "ask", exists: false }]), ["run"]), false);
  assert.equal(connectionUsable(undefined), false);
});
