import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBrowserChoice, type BrowserChoice, type BrowserSelection, type BrowserSelectionState } from "./browser-selection.ts";
import { remoteNames } from "./browser-remote.ts";

export const BROWSER_ENTRY = "pi-browser:browser";

/** Follow the current branch, not entries from abandoned branches or tool output. */
function savedOverride(ctx: ExtensionContext): BrowserChoice | null {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== BROWSER_ENTRY) continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || !("browser" in data)) continue;
    if (data.browser === null) return null;
    if (typeof data.browser === "string") return parseBrowserChoice(data.browser);
  }
  return null;
}

function label(choice: BrowserChoice): string {
  return choice.startsWith("remote:") ? `remote ${choice.slice("remote:".length)}` : choice;
}

function description(state: BrowserSelectionState): string {
  return `Browser: ${label(state.effective)} (${state.source === "override" ? "session override" : state.source}). Configured: ${label(state.configured)}. Applies to future browser, web_search, and web_fetch calls; open tabs and running calls are unchanged.`;
}

const USAGE = "Usage: /browser [chromium|firefox|firefox-default-profile|remote <name>|reset|status]";

export function registerBrowserCommand(pi: ExtensionAPI, selection: (ctx: ExtensionContext) => BrowserSelection): void {
  function refresh(ctx: ExtensionContext): BrowserSelectionState {
    const browser = selection(ctx);
    browser.setOverride(savedOverride(ctx));
    const state = browser.getState();
    ctx.ui.setStatus("browser", `browser:${label(state.effective)}${state.override === null ? "" : "*"}`);
    return state;
  }

  function report(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else pi.sendMessage({ customType: "pi-browser:browser-status", content: text, display: true });
  }

  pi.registerCommand("browser", {
    description: "Choose the browser shared by browser, web_search, and web_fetch: chromium, firefox, firefox-default-profile, remote <name>, reset, or status (session override)",
    getArgumentCompletions(prefix) {
      return ["chromium", "firefox", "firefox-default-profile", ...remoteNames().map(name => `remote ${name}`), "reset", "status"]
        .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      let selected = args.trim().replace(/^remote\s+/, "remote:");
      const current = refresh(ctx);
      if (selected === "status" || (!selected && !ctx.hasUI)) { report(ctx, description(current)); return; }
      if (!selected) {
        const choices = [
          { value: "reset", label: `Use configured browser (${label(current.configured)})` },
          { value: "chromium", label: "Chromium (stable Pi profile)" },
          { value: "firefox", label: "Firefox (stable Pi profile)" },
          { value: "firefox-default-profile", label: "Firefox default profile (this user's own; logged-in pages are visible to the agent)" },
          ...remoteNames().map(name => ({ value: `remote:${name}`, label: `Remote ${name}` })),
        ];
        const choice = await ctx.ui.select(description(current), choices.map(choice => choice.label), { signal: ctx.signal });
        const match = choices.find(item => item.label === choice);
        if (!match) return;
        selected = match.value;
      }
      let browser: BrowserChoice | null;
      try { browser = selected === "reset" ? null : parseBrowserChoice(selected); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`); }
      // An explicit null entry clears older branch overrides without changing the environment or open tabs.
      if (savedOverride(ctx) !== browser) pi.appendEntry(BROWSER_ENTRY, { browser });
      report(ctx, description(refresh(ctx)));
    },
  });
  pi.on("session_start", async (_event, ctx) => { refresh(ctx); });
  pi.on("session_tree", async (_event, ctx) => { refresh(ctx); });
  pi.on("input", async (_event, ctx) => { refresh(ctx); });
}
