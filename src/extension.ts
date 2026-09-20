import path from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBrowserTool } from "./browser-tool.ts";
import { registerBrowserRemoteSetup } from "./browser-remote.ts";
import { registerWebBackendCommand } from "./backend-command.ts";
import { createBrowserDefault, type BrowserDefault } from "./browser-default.ts";
import { registerBrowserDefaultCommand } from "./browser-default-command.ts";
import { createWebTools, resolveWebSettings, SnapshotStore, WebAttentionRequired } from "./web/index.ts";
import { copySnapshotTree } from "./snapshot-copy.ts";

function sessionRoot(session: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error("Invalid browser snapshot session ID.");
  return path.join(getAgentDir(), "browser", session);
}

/** Static definitions are available during tool selection; resources start only on execution. */
export default function browserExtension(pi: ExtensionAPI): void {
  // Factories allocate only inert definitions. Their execute methods are never
  // registered: session-owned implementations supply execution below. Keep the
  // schemas in the tool factories rather than duplicating them in the adapter.
  const webTemplate = createWebTools();
  const browserTemplate = createBrowserTool({ profileDir: "", artifactDir: "" });
  let closing: Promise<void> | undefined;
  let ready: Promise<void> = Promise.resolve();
  let host: { web: ReturnType<typeof createWebTools>; browser: ReturnType<typeof createBrowserTool>; defaults: BrowserDefault } | undefined;

  function runtime(ctx: ExtensionContext) {
    if (closing) throw new Error("pi-browser extension is shut down.");
    if (host) return host;
    const session = ctx.sessionManager.getSessionId();
    const root = sessionRoot(session);
    const snapshots = new SnapshotStore({ directory: path.join(root, "snapshots") });
    const settings = resolveWebSettings({}, process.env, path.join(root, "research"));
    const defaults = createBrowserDefault();
    host = {
      defaults,
      web: createWebTools({
        snapshots,
        browserDefault: defaults,
        profileDir: path.join(root, "research"),
        onAttention: async (request, signal) => {
          if (!ctx.hasUI) throw new WebAttentionRequired(request.reason, request.tabId, request.url, settings.headless);
          return ctx.ui.confirm("Web browser needs attention", `${request.reason}\n\n${request.url}\nTab: ${request.tabId}\n\nResolve it in the research browser, then confirm to continue without reloading.`, { signal });
        },
      }),
      browser: createBrowserTool({
        snapshots,
        browserDefault: defaults,
        profileDir: path.join(root, "manual"), artifactDir: snapshots.directory,
        browser: settings.browser, headless: settings.headless, executable: settings.executable,
        onSetup: ctx.hasUI ? (instructions, signal) => ctx.ui.confirm("Browser connection needs setup", `${instructions}\n\nAfter restoring the publisher tunnel/browser, confirm to retry once. Decline to return the connection error.`, { signal }) : undefined,
      }),
    };
    return host;
  }

  for (const definition of webTemplate.tools) {
    pi.registerTool({
      ...definition,
      async execute(id, params, signal, onUpdate, ctx) {
        await ready;
        const tool = runtime(ctx).web.tools.find(tool => tool.name === definition.name)!;
        return tool.execute(id, params, signal, onUpdate, ctx);
      },
    });
  }
  pi.registerTool({
    ...browserTemplate.tool,
    async execute(id, params, signal, onUpdate, ctx) {
      await ready;
      return runtime(ctx).browser.tool.execute(id, params, signal, onUpdate, ctx);
    },
  });
  registerWebBackendCommand(pi, ctx => runtime(ctx).web);
  registerBrowserDefaultCommand(pi, ctx => runtime(ctx).defaults);
  registerBrowserRemoteSetup(pi);
  pi.registerCommand("browser-close", {
    description: "Close the browser-tool destination: [remote], defaulting to PI_BROWSER_REMOTE or local launch. External browsers remain open. Profiles and evidence are retained.",
    async handler(args, ctx) {
      if (!host) { ctx.ui.notify("No browsers are open.", "info"); return; }
      await host.browser.closeBrowser(args.trim() || undefined);
      ctx.ui.notify("Browser closed.", "info");
    },
  });
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "fork") return;
    // Keep failures on the execution gate too: Pi reports lifecycle errors but
    // continues the session. Calls must not silently use an incomplete fork.
    ready = (async () => {
      if (!event.previousSessionFile) throw new Error("Snapshot fork requires the previous session file.");
      const previous = SessionManager.open(event.previousSessionFile).getSessionId();
      await copySnapshotTree(path.join(sessionRoot(previous), "snapshots"),
        path.join(sessionRoot(ctx.sessionManager.getSessionId()), "snapshots"));
    })();
    await ready;
  });
  pi.on("session_shutdown", () => {
    closing ??= (async () => {
      const results = await Promise.allSettled([webTemplate.close(), browserTemplate.close(), host?.web.close(), host?.browser.close()]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "pi-browser shutdown failed");
    })();
    return closing;
  });
}
