// The folder Claude threads started from the wiki work in: `<LAYR_DATA_DIR>/Wiki`, with a CLAUDE.md that tells every
// such thread how to reach the wiki (its tools, never the folder copy's files). It holds nothing else, so a thread
// working there can't damage real files; the panel starts the threads in it (panels/ai/ask.js).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const THREAD_FOLDER_NAME = "Wiki";

export const THREAD_INSTRUCTIONS = `# Threads started from the Wiki

The user opened this thread from their layr Wiki. This folder only holds this file: the wiki itself is not here.

- Read and change the wiki only with its tools (\`mcp__layr__wiki__*\`; call \`wiki__guide\` once before writing).
  Every change made that way can be undone by the user.
- Never edit the Markdown files of the wiki's folder copy (the Obsidian folder): it is a one-way copy, so edits there
  are overwritten and never reach the wiki.
- Other plugins' tools (\`mcp__layr__*\`) are there too: use them when the user wants data from Research, a web page,
  Concepts and so on. What they may do is decided by layr's Settings > Tool access.
- This thread can't edit files or run programs on the PC. If the user asks for that, say so instead of trying.
- Links to wiki pages: \`layr://wiki/page/<id>\` open the page in the Wiki.
`;

/** Make the folder and its CLAUDE.md when missing (an old CLAUDE.md is brought up to date). Gives the folder's path. */
export async function ensureThreadFolder(dataDir, fs = { mkdir, readFile, writeFile }) {
  if (!dataDir) throw new Error("The wiki's data folder isn't known (LAYR_DATA_DIR): start it from layr");
  const dir = path.join(dataDir, THREAD_FOLDER_NAME);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "CLAUDE.md");
  const old = await fs.readFile(file, "utf8").catch(() => null);
  if (old !== THREAD_INSTRUCTIONS) await fs.writeFile(file, THREAD_INSTRUCTIONS, "utf8");
  return dir;
}
