import { defineTool, truncateHead, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BrowserUnavailable, type BrowserClient, type SharedTab } from "./broker/client.ts";
import type { TabInfo } from "./broker/protocol.ts";
import { capturePage } from "./capture.ts";
import type { BrowserKind } from "./core/types.ts";
import { publicBrowserError } from "./core/process.ts";
import { SnapshotStore, snapshotSummary, type SnapshotInput, type SnapshotFormat } from "./snapshots.ts";
import { remoteSetupInstructions, type BrowserSetupHandler } from "./browser-remote.ts";
import { abortable } from "./web/async.ts";

export interface BrowserToolOptions {
  /** The selected shared browser, resolved per call; owned and closed by the host. */
  browser: () => BrowserClient | Promise<BrowserClient>;
  snapshots?: SnapshotStore;
  onSetup?: BrowserSetupHandler;
}

export interface BrowserResultDetails {
  browser: BrowserKind;
  remote?: string;
  tab: string;
  url: string;
  title: string;
  snapshot: string;
  available: SnapshotFormat[];
  truncated: boolean;
  warnings?: string[];
  eval_result?: unknown;
  eval_preview?: string;
  eval_error?: string;
}

export interface BrowserListDetails { tabs: TabInfo[] }

/** Remote connection failures may be fixed by a person; retry once after confirmation, never replaying page work. */
async function withSetup<T>(client: BrowserClient, run: () => Promise<T>, signal: AbortSignal | undefined, onSetup?: BrowserSetupHandler): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!(error instanceof BrowserUnavailable) || !("remote" in client.source)) throw error;
    const instructions = remoteSetupInstructions(error.message);
    const confirmed = onSetup && await abortable(onSetup(instructions, signal ?? new AbortController().signal), signal);
    signal?.throwIfAborted();
    if (!confirmed) throw new Error(`${instructions}\n${onSetup ? "Retry was declined." : "No interactive setup confirmation is available."}`);
    return run();
  }
}

function formatTabs(tabs: TabInfo[]): string {
  if (!tabs.length) return "No tabs are open.";
  return tabs.map(tab => `${tab.current ? "* " : "  "}${tab.name} — ${tab.title || "(untitled)"} — ${tab.url}` +
    (tab.lastSession ? ` — last used by ${tab.lastSession} at ${tab.lastUsedAt}` : " — not used through Pi yet") +
    (tab.openedBy === "other" ? " — not opened by Pi; never closed automatically" : "")).join("\n") +
    "\n\n* marks this session's default tab.";
}

/** Named tabs in the one shared browser produce immutable evidence. */
export function createBrowserTool(options: BrowserToolOptions) {
  const snapshots = options.snapshots ?? new SnapshotStore();
  const tool = defineTool({
    name: "browser", label: "Browser",
    description: "Use named tabs of the browser shared by all Pi sessions (selected by the user with /browser) and optionally evaluate JavaScript (async IIFEs; Promises awaited). Every tab has a name, also tabs from web_search/web_fetch and other sessions. Omitted tab uses this session's last tab; an unknown tab with url opens a new tab with that name; omitted tab with url and no usable last tab opens an automatically named tab (host without www plus +length of the rest, e.g. google.com+6). Omit url to keep the page. list:true lists all tabs with their last user. Pi-opened tabs outside every session's 10 most recently used tabs close automatically. Calls on the same tab run one after another; different tabs run in parallel. Returns a compact receipt with tab, URL and snapshot ID; web_read reads final md/text/html/json/screenshot or before-screenshot (after navigation, before eval). Inspect HTML first, screenshots for visual evidence. Large eval results live in snapshot JSON. Interrupted eval closes its tab. Ordinary eval errors keep the tab.",
    parameters: Type.Object({
      tab: Type.Optional(Type.String({ description: "Tab name. Omit for this session's last tab." })),
      url: Type.Optional(Type.String({ description: "HTTP(S) URL to navigate to before capture/eval. Omit to keep the current page." })),
      eval: Type.Optional(Type.String({ description: "JavaScript expression evaluated once; returned Promises are awaited." })),
      list: Type.Optional(Type.Boolean({ description: "List all tabs instead of using one." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal): Promise<AgentToolResult<BrowserResultDetails | BrowserListDetails>> {
      signal?.throwIfAborted();
      const client = await options.browser();
      if (params.list) {
        if (params.tab !== undefined || params.url !== undefined || params.eval !== undefined) throw new Error("list cannot be combined with tab, url, or eval.");
        const tabs = await withSetup(client, () => client.list(signal), signal, options.onSetup);
        return { content: [{ type: "text", text: formatTabs(tabs) }], details: { tabs } };
      }
      if (params.url !== undefined) {
        const url = new URL(params.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URL must be HTTP(S) without embedded credentials.");
      }
      const remote = "remote" in client.source ? client.source.remote : undefined;
      const evidence: SnapshotInput = { kind: "browser", metadata: { ...(remote === undefined ? {} : { remote }),
        ...(params.url ? { requestedUrl: params.url } : {}), ...(params.eval !== undefined ? { expression: params.eval } : {}) }, warnings: [] };
      // The call holds its tab from open to release, so concurrent calls on it never interleave.
      let tab: SharedTab | undefined;
      try {
        const opened = await withSetup(client, () => client.open({ tab: params.tab, url: params.url }, signal), signal, options.onSetup);
        tab = opened.tab;
        Object.assign(evidence.metadata, { browser: opened.browser, tab: tab.name });
        if (params.url) await tab.navigate(params.url, { signal });
        signal?.throwIfAborted();
        await tab.focus();
        signal?.throwIfAborted();
        try {
          evidence.beforeScreenshot = await tab.screenshot();
          evidence.metadata.beforeScreenshotCapturedAt = new Date().toISOString();
        } catch (error) { evidence.warnings!.push(`Before-screenshot unavailable: ${publicBrowserError(error)}`); }
        signal?.throwIfAborted();
        let evalResult: unknown;
        let evalError: string | undefined;
        if (params.eval !== undefined) {
          try {
            evalResult = await tab.evaluate(params.eval, { signal, timeoutMs: 30_000 });
            evidence.metadata.eval_result = evalResult ?? null;
            evidence.metadata.evalType = evalResult === undefined ? "undefined" : evalResult === null ? "null" : typeof evalResult;
          } catch (error) {
            if (signal?.aborted || tab.closed) throw error;
            evalError = error instanceof Error ? error.message : String(error);
            evidence.metadata.eval_error = evalError;
          }
        }
        signal?.throwIfAborted();
        try {
          const capture = await capturePage(tab, { signal, timeoutMs: 5000 });
          Object.assign(evidence, { html: capture.html, md: capture.md, text: capture.text, json: capture.json });
          evidence.metadata.capturedAt = capture.capturedAt;
          evidence.warnings!.push(...capture.warnings);
        } catch (error) {
          if (signal?.aborted) throw error;
          evidence.warnings!.push(`Page capture unavailable: ${publicBrowserError(error)}`);
        }
        signal?.throwIfAborted();
        try {
          evidence.screenshot = await tab.screenshot();
          evidence.metadata.screenshotCapturedAt = new Date().toISOString();
        } catch (error) { evidence.warnings!.push(`Screenshot unavailable: ${publicBrowserError(error)}`); }
        signal?.throwIfAborted();
        // The final capture is authoritative; another live evaluation could observe
        // a later navigation and falsely relabel this immutable evidence.
        const info = { url: typeof evidence.json?.url === "string" ? evidence.json.url : params.url ?? "",
          title: typeof evidence.json?.title === "string" ? evidence.json.title : "Page metadata unavailable" };
        evidence.metadata = { ...evidence.metadata, ...info, status: evalError ? "eval-error" : "complete" };
        const saved = await snapshots.save(evidence);
        signal?.throwIfAborted();
        const serialized = params.eval === undefined ? undefined : JSON.stringify(evalResult ?? null);
        const preview = serialized === undefined ? undefined : truncateHead(serialized, { maxBytes: 4096, maxLines: 60 });
        const details: BrowserResultDetails = {
          browser: opened.browser, ...(remote === undefined ? {} : { remote }), tab: tab.name, ...info,
          snapshot: saved.id, available: saved.available, truncated: preview?.truncated ?? false,
          ...(opened.warnings.length ? { warnings: opened.warnings } : {}),
          ...(preview ? preview.truncated ? { eval_preview: preview.content } : { eval_result: evalResult ?? null } : {}),
          ...(evalError ? { eval_error: evalError } : {}),
        };
        const receipt = [snapshotSummary(saved),
          `Tab: ${tab.name}${opened.created ? " (new)" : ""} in ${opened.browser}${remote === undefined ? "" : ` on remote ${remote}`}`,
          `Page: ${info.title} — ${info.url}`,
          ...opened.warnings.map(warning => `Warning: ${warning}`),
          ...(evalError ? [`Evaluation error: ${evalError}`] : preview ? [`Evaluation: ${preview.content}${preview.truncated ? "\n[Evaluation preview truncated; full captured result in web_read json.]" : ""}`] : [])].join("\n");
        const bounded = truncateHead(receipt, { maxBytes: 8 * 1024, maxLines: 100 });
        return { content: [{ type: "text" as const, text: bounded.content + (bounded.truncated ? "\n[Receipt truncated; use web_read json.]" : "") }], details };
      } catch (error) {
        // Never run fresh capture/eval after cancellation. Completed evidence stays useful.
        const failure = new Error(publicBrowserError(error));
        evidence.metadata.status = signal?.aborted ? "cancelled" : "error";
        evidence.metadata.error = failure.message;
        try {
          const saved = await snapshots.save(evidence);
          failure.message += `\n${snapshotSummary(saved)}`;
          Object.assign(failure, { snapshot: saved.id });
        } catch { failure.message += "\nSnapshot unavailable: private storage could not retain this operation."; }
        throw failure;
      } finally { await tab?.release(); }
    },
  });
  return { tool, snapshots };
}
