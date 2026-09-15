import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBrowserKind, type BrowserDefault, type BrowserDefaultState } from "./browser-default.ts";
import type { BrowserKind } from "./core/index.ts";

export const BROWSER_DEFAULT_ENTRY = "pi-browser:browser-default";

/** Follow the current branch, not entries from abandoned branches or tool output. */
function savedOverride(ctx: ExtensionContext): BrowserKind | null {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== BROWSER_DEFAULT_ENTRY) continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || !("browser" in data)) continue;
    if (data.browser === null || isBrowserKind(data.browser)) return data.browser;
  }
  return null;
}

function description(state: BrowserDefaultState): string {
  return `Browser default: ${state.effective} (${state.source === "override" ? "session override" : state.source}). Configured default: ${state.configured}. Changes apply to future browser-backed web calls and new browser sessions; existing sessions and active requests are unchanged.`;
}

export function registerBrowserDefaultCommand(pi: ExtensionAPI, defaults: (ctx: ExtensionContext) => BrowserDefault): void {
  function refresh(ctx: ExtensionContext): BrowserDefaultState {
    const browser = defaults(ctx);
    browser.setOverride(savedOverride(ctx));
    const state = browser.getState();
    ctx.ui.setStatus("browser-default", `browser:${state.effective}${state.override === null ? "" : "*"}`);
    return state;
  }

  function report(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else pi.sendMessage({ customType: "pi-browser:browser-default-status", content: text, display: true });
  }

  pi.registerCommand("browser-default", {
    description: "Choose the engine for future browser-backed web calls and new browser sessions: chromium, firefox, reset, or status (session override)",
    getArgumentCompletions(prefix) {
      return ["chromium", "firefox", "reset", "status"].filter(value => value.startsWith(prefix))
        .map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      let selected = args.trim();
      if (selected && selected !== "reset" && selected !== "status" && !isBrowserKind(selected)) {
        throw new Error("Usage: /browser-default [chromium|firefox|reset|status]");
      }
      const current = refresh(ctx);
      if (selected === "status" || (!selected && !ctx.hasUI)) { report(ctx, description(current)); return; }
      if (!selected) {
        const choices = [
          { value: "reset", label: `Use configured default (${current.configured})` },
          { value: "chromium", label: "Chromium" },
          { value: "firefox", label: "Firefox" },
        ];
        const choice = await ctx.ui.select(description(current), choices.map(choice => choice.label), { signal: ctx.signal });
        const match = choices.find(item => item.label === choice);
        if (!match) return;
        selected = match.value;
      }
      const browser = selected === "reset" ? null : selected;
      if (browser !== null && !isBrowserKind(browser)) throw new Error("Invalid browser default.");
      // An explicit null entry clears older branch overrides without changing
      // the process environment or closing existing browser resources.
      if (savedOverride(ctx) !== browser) pi.appendEntry(BROWSER_DEFAULT_ENTRY, { browser });
      report(ctx, description(refresh(ctx)));
    },
  });
  pi.on("session_start", async (_event, ctx) => { refresh(ctx); });
  pi.on("session_tree", async (_event, ctx) => { refresh(ctx); });
  pi.on("input", async (_event, ctx) => { refresh(ctx); });
}
