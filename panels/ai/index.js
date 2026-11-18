// Part E, the AI: `app.ai` (Claude through the Claude Code plugin's `ask`, web pages through Web tools), Ask your
// wiki, AI actions on selected text, suggested links and tags, the review inbox and the web clipper. Each piece is
// installed on its own, so one that fails leaves the others working.
import { createAi } from "./client.js";
import { installActions } from "./actions.js";
import { installAsk } from "./ask.js";
import { installClipper } from "./clip.js";
import { installReview } from "./review.js";
import { installSuggest } from "./suggest.js";

function loadCss(href) {
  if ([...document.querySelectorAll("link[rel=stylesheet]")].some((l) => l.href === href)) return;
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));
}

export function install(app) {
  loadCss(new URL("./ai.css", import.meta.url).href);
  app.ai = createAi(app);
  // Buttons that depend on Claude or Web tools show or hide when a connection changes.
  app.ai.onChange(() => {
    app.emit?.("ai", { available: app.ai.available() });
    app.emit?.("layout", {});
  });
  for (const part of [installAsk, installActions, installSuggest, installReview, installClipper]) {
    try {
      part(app);
    } catch (error) {
      console.error(`wiki ai: ${part.name}`, error);
    }
  }
}
