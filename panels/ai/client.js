// `app.ai`: the wiki's way to Claude, through the Claude Code plugin: its `ask` tool (one turn, no tools, on the PC's
// Claude Code sign-in) for the small AI actions, its threads for Ask Claude (ask.js); and to web pages through Web
// tools (`scraper`). Both are optional connections (layr.json): the AI's buttons show only while the connection is
// usable, and a call it refuses says how to allow it.

const CLAUDE = "claude";
const SCRAPER = "scraper";

/** A refused or failed call → an error whose message tells the user what to do. */
export function aiError(error, what = "Claude Code") {
  const code = error?.code;
  const codes = globalThis.layr?.errors ?? {};
  if (code === codes.NOT_ALLOWED) {
    return new Error(`The wiki isn't allowed to use ${what}. Allow it in layr's Settings › Tool access (Wiki).`);
  }
  if (code === codes.NOT_FOUND) return new Error(`${what} isn't installed: install it from layr's store.`);
  if (code === codes.NOT_AVAILABLE) return new Error(`${what} runs on your PC: start layr there and try again.`);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Whether a connection's groups can be used: allowed, or not decided yet (the first call asks the user, so the button
 * shows). A denied group, a missing plugin or a blocked one says no. `groups`: the ones that matter (all when left out).
 */
export function connectionUsable(c, groups = null) {
  if (!c?.installed || c.blocked || ["missing", "version", "blocked"].includes(c.state)) return false;
  const all = c.groups ?? [];
  const named = groups ? all.filter((g) => groups.includes(g.id)) : all;
  if (groups && named.length < groups.length) return false;
  return named.every((g) => g.exists !== false && g.rule !== "deny");
}

/** What a thread opened from the wiki may use without asking: reading, the web, and layr's tools (Tool access decides). */
export const THREAD_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "mcp__layr"];

export function createAi(app) {
  const state = { claude: false, threads: false, scraper: false, checked: false };
  const listeners = new Set();
  const tell = () => {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {
        // one listener's problem is its own
      }
    }
  };

  async function check() {
    try {
      const { connections = [] } = await layr.connections.get();
      const find = (id) => connections.find((x) => x.plugin === id);
      state.claude = connectionUsable(find(CLAUDE), ["ask"]);
      state.threads = connectionUsable(find(CLAUDE), ["run", "read"]);
      state.scraper = connectionUsable(find(SCRAPER));
    } catch {
      state.claude = false;
      state.threads = false;
      state.scraper = false;
    }
    state.checked = true;
    tell();
    return state;
  }
  const ready = check();
  try {
    layr.connections.onChange?.(() => check());
  } catch {
    // an older layr: checked once
  }

  return {
    ready,
    check,
    /** Claude is there and the wiki may ask it. */
    available: () => state.claude,
    /** Claude threads can be started from the wiki (Ask Claude). */
    canThread: () => state.threads,
    /** A Claude Code plugin tool (threads); a refused call says how to allow it. */
    async claude(tool, args = {}) {
      try {
        return await layr.tools.run(tool, args, { plugin: CLAUDE });
      } catch (error) {
        if (error?.code === layr.errors?.NOT_ALLOWED || error?.code === layr.errors?.NOT_FOUND) check();
        throw aiError(error, "Claude Code");
      }
    },
    /** Web tools are there (the clipper). */
    canClip: () => state.scraper,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** One question, one answer (text). `model`: the setting aiModel unless given. */
    async ask(prompt, { system, model, effort } = {}) {
      const args = { prompt, model: model ?? app.settings?.get?.("aiModel") ?? "sonnet" };
      if (system) args.system = system;
      if (effort) args.effort = effort;
      let result;
      try {
        result = await layr.tools.run("ask", args, { plugin: CLAUDE });
      } catch (error) {
        if (error?.code === layr.errors?.NOT_ALLOWED || error?.code === layr.errors?.NOT_FOUND) check();
        throw aiError(error, "Claude Code");
      }
      const text = typeof result === "string" ? result : result?.text;
      if (!text?.trim()) throw new Error("Claude gave an empty answer: try again");
      return text;
    },
    /** A web page as Markdown through Web tools: `{title, url, content, truncated}`. */
    async readWeb(url) {
      try {
        return await layr.tools.run("scrape", { url, main: true, maxChars: 200000 }, { plugin: SCRAPER });
      } catch (error) {
        if (error?.code === layr.errors?.NOT_ALLOWED || error?.code === layr.errors?.NOT_FOUND) check();
        throw aiError(error, "Web tools");
      }
    },
  };
}
