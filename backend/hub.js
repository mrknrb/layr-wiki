// The backend's link to the core's MCP hub (docs/ARCHITECTURE.md › The MCP hub): the plugin's own data, its
// settings, events to its panels, and the user's Supabase session (attachments). Same as the concepts plugin's.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const log = (...parts) => console.error("[wiki]", ...parts);
export const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export class Hub {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
    this.client = null;
    this.connecting = null;
    this.warned = false;
  }

  get available() {
    return Boolean(this.url && this.token);
  }

  async connect() {
    if (this.client) return this.client;
    if (!this.available) throw new Error("No hub: LAYR_HUB_URL and LAYR_HUB_TOKEN are not set");
    this.connecting ??= (async () => {
      const client = new Client({ name: "layr-plugin-wiki", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
      });
      client.onclose = () => {
        if (this.client === client) this.client = null;
      };
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  /** Call a hub tool; gives its value (structured content unwrapped, or its text parsed as JSON when it is JSON). */
  async call(name, args = {}) {
    let client = await this.connect();
    let result;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch {
      // The core may have restarted its HTTP session: connect once more.
      this.client = null;
      client = await this.connect();
      result = await client.callTool({ name, arguments: args });
    }
    if (result.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      throw new Error(text || `${name} failed`);
    }
    const sc = result.structuredContent;
    if (sc && typeof sc === "object" && !Array.isArray(sc)) {
      const keys = Object.keys(sc);
      return keys.length === 1 && keys[0] === "result" ? sc.result : sc;
    }
    const text = (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** The names of the hub tools this plugin may call. */
  async toolNames() {
    const client = await this.connect();
    const names = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return names;
  }

  /** Fire and forget: an event for the panels. Failures are logged once, not thrown. */
  emit(topic, data) {
    if (!this.available) return;
    this.call("layr__events_emit", { topic, data }).catch((error) => {
      if (!this.warned) {
        this.warned = true;
        log(`events_emit failed (further failures not logged): ${errorMessage(error)}`);
      }
    });
  }
}
