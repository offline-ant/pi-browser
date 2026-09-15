import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWebBackend, type WebBackend, type WebBackendState, type WebToolSet } from "./web/index.ts";

export const WEB_BACKEND_ENTRY = "pi-browser:web-backend";

/** Follow the current branch, not entries from abandoned branches or tool output. */
function savedOverride(ctx: ExtensionContext): WebBackend | null {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== WEB_BACKEND_ENTRY) continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || !("backend" in data)) continue;
    if (data.backend === null || isWebBackend(data.backend)) return data.backend;
  }
  return null;
}

function description(state: WebBackendState): string {
  return `Web backend: ${state.effective} (${state.source === "override" ? "session override" : state.source}). Configured default: ${state.configured}. Changes apply to subsequent calls; active requests are unchanged.`;
}

export function registerWebBackendCommand(pi: ExtensionAPI, webTools: (ctx: ExtensionContext) => WebToolSet): void {
  function refresh(ctx: ExtensionContext): WebBackendState {
    const web = webTools(ctx);
    web.setBackendOverride(savedOverride(ctx));
    const state = web.getBackendState();
    ctx.ui.setStatus("web-backend", `web:${state.effective}${state.override === null ? "" : "*"}`);
    return state;
  }

  function report(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else pi.sendMessage({ customType: "pi-browser:web-backend-status", content: text, display: true });
  }

  pi.registerCommand("web-backend", {
    description: "Choose web_search/web_fetch backend: auto, codex, browser, reset, or status (session override)",
    getArgumentCompletions(prefix) {
      return ["auto", "codex", "browser", "reset", "status"].filter(value => value.startsWith(prefix))
        .map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      let selected = args.trim();
      if (selected && selected !== "reset" && selected !== "status" && !isWebBackend(selected)) {
        throw new Error("Usage: /web-backend [auto|codex|browser|reset|status]");
      }
      const current = refresh(ctx);
      if (selected === "status" || (!selected && !ctx.hasUI)) { report(ctx, description(current)); return; }
      if (!selected) {
        const choices = [
          { value: "reset", label: `Use configured default (${current.configured})` },
          { value: "auto", label: "Auto — Codex first, browser fallback" },
          { value: "codex", label: "Codex — no fallback" },
          { value: "browser", label: "Browser — no Codex requests" },
        ];
        const choice = await ctx.ui.select(description(current), choices.map(choice => choice.label), { signal: ctx.signal });
        const match = choices.find(item => item.label === choice);
        if (!match) return;
        selected = match.value;
      }
      const backend = selected === "reset" ? null : selected;
      if (backend !== null && !isWebBackend(backend)) throw new Error("Invalid web backend.");
      // An explicit null entry clears older branch overrides. Never change the
      // process environment or reconstruct the research/browser tool instances.
      if (savedOverride(ctx) !== backend) pi.appendEntry(WEB_BACKEND_ENTRY, { backend });
      report(ctx, description(refresh(ctx)));
    },
  });
  pi.on("session_start", async (_event, ctx) => { refresh(ctx); });
  pi.on("session_tree", async (_event, ctx) => { refresh(ctx); });
  pi.on("input", async (_event, ctx) => { refresh(ctx); });
}
