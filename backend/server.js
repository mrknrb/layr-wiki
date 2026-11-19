// The wiki backend (runs on the PC; docs/PLUGINS.md › Backends): an MCP server on stdio with the wiki's tools for AI
// agents and other plugins, and the folder copy of the wiki (mirror.js). The pages are the plugin's own synced data,
// reached through the hub (layr__db_* / layr__data_*), the same store the panel uses on every device. It starts with
// layr (autoStart) so the folder copy follows changes made on the phone too.
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { changedFromSync, createBackend, hubAdapter } from "./core.js";
import { errorMessage, Hub, log } from "./hub.js";
import { GUIDE } from "./tools.js";

async function main() {
  const hub = new Hub({ url: process.env.LAYR_HUB_URL, token: process.env.LAYR_HUB_TOKEN });
  const settings = async () => {
    try {
      return await hub.call("layr__settings_get", {});
    } catch {
      return { mirror: true, folder: "" };
    }
  };
  const backend = createBackend({
    adapter: hubAdapter(hub),
    session: () => hub.call("layr__supabase_session", {}),
    settings,
    device: process.env.LAYR_DEVICE ?? null,
    dataDir: process.env.LAYR_DATA_DIR ?? null,
    log,
  });
  const server = new Server({ name: "wiki", version: "0.3.0" }, { capabilities: { tools: {} }, instructions: GUIDE });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...backend.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args, _meta: meta } = request.params;
      const result = await backend.call(name, args ?? {}, meta);
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
    }
  });
  server.fallbackNotificationHandler = async ({ method, params }) => {
    if (method !== "notifications/layr/event") return;
    const { topic, data } = params ?? {};
    try {
      if (topic === "layr:data.changed") await backend.onChanged(changedFromSync(data));
      else if (topic === "wiki:changed" && data?.origin !== "backend") await backend.onChanged(data);
      else if (topic === "wiki:settings") {
        // layr's settings of the plugin (the folder copy) changed; the wiki's own (data `settings`) are read again too,
        // though they come as wiki:changed {settings: true} (the panel) or layr:data.changed (another device).
        await backend.reloadSettings().catch((e) => log(`settings: ${errorMessage(e)}`));
        backend.mirror.schedule(200);
      }
    } catch (error) {
      log(`event ${topic}: ${errorMessage(error)}`);
    }
  };
  await server.connect(new StdioServerTransport());
  log(`ready: ${backend.tools.size} tools`);
  hub.call("layr__events_subscribe", { topic: "wiki:changed" }).catch((e) => log(`subscribe: ${errorMessage(e)}`));
  // The first copy, then a full one every 10 minutes (the events cover the rest).
  backend.mirror.schedule(3000);
  setInterval(() => backend.mirror.run({ reload: true }).catch((e) => log(`folder copy: ${errorMessage(e)}`)),
    10 * 60 * 1000).unref?.();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log("failed to start:", errorMessage(error));
    process.exit(1);
  });
}
