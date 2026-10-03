import path from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "./broker/client.ts";
import { createBrowserTool } from "./browser-tool.ts";
import { registerBrowserRemoteSetup } from "./browser-remote.ts";
import { registerWebBackendCommand } from "./backend-command.ts";
import { browserHeadless, browserSource, createBrowserSelection, type BrowserChoice, type BrowserSelection } from "./browser-selection.ts";
import { registerBrowserCommand } from "./browser-command.ts";
import { createWebTools, SnapshotStore, WebAttentionRequired } from "./web/index.ts";
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
  const browserTemplate = createBrowserTool({ browser: () => { throw new Error("pi-browser has no session yet."); } });
  let closing: Promise<void> | undefined;
  let ready: Promise<void> = Promise.resolve();
  let host: { web: ReturnType<typeof createWebTools>; browser: ReturnType<typeof createBrowserTool>; selection: BrowserSelection;
    clients: Map<BrowserChoice, Promise<BrowserClient>> } | undefined;

  function runtime(ctx: ExtensionContext) {
    if (closing) throw new Error("pi-browser extension is shut down.");
    if (host) return host;
    const session = ctx.sessionManager.getSessionId();
    const root = sessionRoot(session);
    const snapshots = new SnapshotStore({ directory: path.join(root, "snapshots") });
    const selection = createBrowserSelection();
    const headless = browserHeadless();
    const profiles = path.join(getAgentDir(), "browser", "profiles");
    const clients = new Map<BrowserChoice, Promise<BrowserClient>>();
    // One broker connection per selected browser, shared by browser and web tools so they share this session's tabs.
    const browser = () => {
      const choice = selection.getState().effective;
      let client = clients.get(choice);
      if (!client) {
        const created = browserSource(choice, profiles, headless).then(source => new BrowserClient({ source, session }));
        void created.catch(() => { if (clients.get(choice) === created) clients.delete(choice); });
        clients.set(choice, created);
        client = created;
      }
      return client;
    };
    host = {
      selection, clients,
      web: createWebTools({
        snapshots, browser,
        onAttention: async (request, signal) => {
          if (!ctx.hasUI) throw new WebAttentionRequired(request.reason, request.tab, request.url, headless);
          return ctx.ui.confirm("Web browser needs attention", `${request.reason}\n\n${request.url}\nTab: ${request.tab}\n\nResolve it in the shared browser, then confirm to continue without reloading.`, { signal });
        },
      }),
      browser: createBrowserTool({
        snapshots, browser,
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
  registerBrowserCommand(pi, ctx => runtime(ctx).selection);
  registerBrowserRemoteSetup(pi);
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
      const results = await Promise.allSettled([webTemplate.close(), host?.web.close()]);
      // Disconnecting lets each broker close this session's unused tabs and exit when idle.
      results.push(...await Promise.allSettled([...host?.clients.values() ?? []].map(async client => (await client).close())));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "pi-browser shutdown failed");
    })();
    return closing;
  });
}
