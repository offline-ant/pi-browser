import path from "node:path";
import { defineTool, truncateHead, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { launchBrowser, type BrowserKind, type BrowserSession, type BrowserTab } from "./core/index.ts";
import { createBrowserDefault, type BrowserDefault } from "./browser-default.ts";
import { capturePage } from "./capture.ts";
import { publicBrowserError } from "./core/process.ts";
import { SnapshotStore, snapshotSummary, type SnapshotInput, type SnapshotFormat } from "./snapshots.ts";
import { connectRemote, validateRemote, type BrowserSetupHandler } from "./browser-remote.ts";

export interface BrowserToolOptions {
  profileDir: string;
  artifactDir: string;
  browser?: BrowserKind;
  browserDefault?: BrowserDefault;
  snapshots?: SnapshotStore;
  headless?: boolean;
  executable?: string;
  /** Publisher socket; defaults to PI_BROWSER_REMOTE. */
  remote?: string;
  onSetup?: BrowserSetupHandler;
}

export interface BrowserResultDetails {
  browser: BrowserKind;
  remote?: string;
  tab_id: string;
  url: string;
  title: string;
  snapshot: string;
  available: SnapshotFormat[];
  truncated: boolean;
  eval_result?: unknown;
  eval_preview?: string;
  eval_error?: string;
}

interface DestinationBrowser {
  target: { browser: BrowserKind; remote?: string };
  owner: BrowserSession;
  tab: BrowserTab;
}

/** One persistent tab per destination produces immutable evidence. */
export function createBrowserTool(options: BrowserToolOptions) {
  const snapshots = options.snapshots ?? new SnapshotStore({ directory: options.artifactDir || undefined });
  const defaults = options.browserDefault ?? createBrowserDefault({ browser: options.browser });
  const executableBrowser = options.browser ?? defaults.getState().configured;
  const defaultRemote = options.remote ?? process.env.PI_BROWSER_REMOTE;
  const browsers = new Map<string | undefined, DestinationBrowser>();
  const queues = new Map<string | undefined, Promise<unknown>>();
  const stopped = new AbortController();
  let closing: Promise<void> | undefined;

  // Undefined is the local destination; remote names have their own queues.
  // Cancellation of a waiter never releases the running destination's slot.
  function enqueue<T>(id: string | undefined, run: () => Promise<T>, signal = stopped.signal): Promise<T> {
    signal.throwIfAborted();
    stopped.signal.throwIfAborted();
    let abort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    const operation = (queues.get(id) ?? Promise.resolve()).then(() => {
      signal.removeEventListener("abort", abort);
      signal.throwIfAborted();
      stopped.signal.throwIfAborted();
      return run();
    });
    const settled = operation.then(() => {}, () => {}).finally(() => {
      if (queues.get(id) === settled) queues.delete(id);
    });
    queues.set(id, settled);
    return Promise.race([operation, cancelled]).finally(() => signal.removeEventListener("abort", abort));
  }

  const tool = defineTool({
    name: "browser", label: "Browser",
    description: "Navigate one persistent Chromium/Firefox tab per destination and optionally evaluate JavaScript (async IIFEs; Promises awaited). Optional remote selects a named publisher socket; omitted uses PI_BROWSER_REMOTE or launches locally. /browser-remote-setup lists names and prints publisher instructions. Attachment opens its own tab, never takes over human tabs or stops the external browser. Connection failure shows setup instructions and asks for one retry when interactive. Calls to the same destination reuse its tab and engine; use /browser-close [remote] before changing its engine. Omit url to preserve the page. Returns a compact receipt and snapshot ID; web_read reads final md/text/html/json/screenshot or before-screenshot (after navigation, before eval). Inspect HTML first, screenshots for visual evidence. Large eval results live in snapshot JSON. Local launch is headed; missing display is an error. Interrupted eval closes its attached tab, local Chromium tab, or owned Firefox process; uncertain termination is reported. Ordinary eval errors retain the tab. Saved evidence is bounded and reports omissions.",
    parameters: Type.Object({
      browser: Type.Optional(StringEnum(["chromium", "firefox"] as const, { description: "Engine when opening this destination; omitted uses /browser-default (PI_WEB_BROWSER) or preserves its existing engine." })),
      remote: Type.Optional(Type.String({ description: "Publisher hostname, e.g. void-flip, published by inbound SSH. Defaults to PI_BROWSER_REMOTE, or local launch when unset. Use /browser-remote-setup for discovered names and publisher instructions.", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$" })),
      url: Type.Optional(Type.String({ description: "HTTP(S) URL to navigate to before capture/eval. Omit to keep the current page." })),
      eval: Type.Optional(Type.String({ description: "JavaScript expression evaluated once; returned Promises are awaited." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal): Promise<AgentToolResult<BrowserResultDetails>> {
      const combined = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
      combined.throwIfAborted();
      const remote = params.remote ?? defaultRemote;
      if (remote !== undefined) validateRemote(remote);
      const closeCommand = `/browser-close${remote === undefined ? "" : ` ${remote}`}`;
      if (params.browser !== undefined && params.browser !== "chromium" && params.browser !== "firefox") throw new Error("Invalid browser engine.");
      if (params.url !== undefined) {
        const url = new URL(params.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URL must be HTTP(S) without embedded credentials.");
      }
      const defaultBrowser = defaults.getState().effective;
      const evidence: SnapshotInput = { kind: "browser", metadata: { browser: params.browser ?? defaultBrowser,
        ...(remote === undefined ? {} : { remote }),
        ...(params.url ? { requestedUrl: params.url } : {}), ...(params.eval !== undefined ? { expression: params.eval } : {}) }, warnings: [] };
      try {
        return await enqueue(remote, async () => {
          combined.throwIfAborted();
          let session = browsers.get(remote);
          if (session && params.browser !== undefined && params.browser !== session.target.browser) {
            throw new Error(`This destination already uses ${session.target.browser}. Use ${closeCommand} before changing its engine.`);
          }
          const target = session?.target ?? { browser: params.browser ?? defaultBrowser, ...(remote === undefined ? {} : { remote }) };
          const browser = target.browser;
          Object.assign(evidence.metadata, target);
          if (remote !== undefined && session && (session.owner.closed || session.tab.closed)) {
            throw new Error(`Remote ${remote} lost its connection or tab. Use ${closeCommand}, then reconnect explicitly. No operation was replayed; previously running JavaScript may continue if termination was not confirmed.`);
          }
          if (session?.owner.closed) {
            await session.owner.close();
            browsers.delete(remote);
            session = undefined;
          }
          if (!session) {
            const owner = remote === undefined
              ? await launchBrowser({ browser, profileDir: path.join(options.profileDir, browser), headless: options.headless, executable: browser === executableBrowser ? options.executable : undefined })
              : await connectRemote(remote, browser, combined, options.onSetup);
            try {
              combined.throwIfAborted();
              const tab = await owner.openTab();
              combined.throwIfAborted();
              session = { target, owner, tab };
              browsers.set(remote, session);
            } catch (error) {
              await owner.close();
              throw error;
            }
          } else if (session.tab.closed) session.tab = await session.owner.openTab();
          evidence.metadata.browser = session.target.browser;
          evidence.metadata.tab_id = session.tab.id;
          combined.throwIfAborted();
          if (params.url) await session.tab.navigate(params.url, { signal: combined });
          combined.throwIfAborted();
          await session.tab.focus();
          combined.throwIfAborted();
          try {
            evidence.beforeScreenshot = await session.tab.screenshot();
            evidence.metadata.beforeScreenshotCapturedAt = new Date().toISOString();
          } catch (error) { evidence.warnings!.push(`Before-screenshot unavailable: ${publicBrowserError(error)}`); }
          combined.throwIfAborted();
          let evalResult: unknown;
          let evalError: string | undefined;
          if (params.eval !== undefined) {
            try {
              evalResult = await session.tab.evaluate(params.eval, { signal: combined, timeoutMs: 30_000 });
              evidence.metadata.eval_result = evalResult ?? null;
              evidence.metadata.evalType = evalResult === undefined ? "undefined" : evalResult === null ? "null" : typeof evalResult;
            } catch (error) {
              if (combined.aborted || session.tab.closed) throw error;
              evalError = error instanceof Error ? error.message : String(error);
              evidence.metadata.eval_error = evalError;
            }
          }
          combined.throwIfAborted();
          try {
            const capture = await capturePage(session.tab, { signal: combined, timeoutMs: 5000 });
            Object.assign(evidence, { html: capture.html, md: capture.md, text: capture.text, json: capture.json });
            evidence.metadata.capturedAt = capture.capturedAt;
            evidence.warnings!.push(...capture.warnings);
          } catch (error) {
            if (combined.aborted) throw error;
            evidence.warnings!.push(`Page capture unavailable: ${publicBrowserError(error)}`);
          }
          combined.throwIfAborted();
          try {
            evidence.screenshot = await session.tab.screenshot();
            evidence.metadata.screenshotCapturedAt = new Date().toISOString();
          } catch (error) { evidence.warnings!.push(`Screenshot unavailable: ${publicBrowserError(error)}`); }
          combined.throwIfAborted();
          // The final capture is authoritative; another live evaluation could observe
          // a later navigation and falsely relabel this immutable evidence.
          const info = { url: typeof evidence.json?.url === "string" ? evidence.json.url : params.url ?? "",
            title: typeof evidence.json?.title === "string" ? evidence.json.title : "Page metadata unavailable" };
          combined.throwIfAborted();
          evidence.metadata = { ...evidence.metadata, ...info, status: evalError ? "eval-error" : "complete" };
          const saved = await snapshots.save(evidence);
          combined.throwIfAborted();
          const serialized = params.eval === undefined ? undefined : JSON.stringify(evalResult ?? null);
          const preview = serialized === undefined ? undefined : truncateHead(serialized, { maxBytes: 4096, maxLines: 60 });
          const details: BrowserResultDetails = {
            ...session.target, tab_id: session.tab.id, ...info,
            snapshot: saved.id, available: saved.available, truncated: preview?.truncated ?? false,
            ...(preview ? preview.truncated ? { eval_preview: preview.content } : { eval_result: evalResult ?? null } : {}),
            ...(evalError ? { eval_error: evalError } : {}),
          };
          const receipt = [`${snapshotSummary(saved)}`, `Browser: ${session.target.browser} (${session.target.remote ? `remote ${session.target.remote}` : "local launch"})`,
            `Page: ${info.title} — ${info.url}`,
            ...(evalError ? [`Evaluation error: ${evalError}`] : preview ? [`Evaluation: ${preview.content}${preview.truncated ? "\n[Evaluation preview truncated; full captured result in web_read json.]" : ""}`] : [])].join("\n");
          const bounded = truncateHead(receipt, { maxBytes: 8 * 1024, maxLines: 100 });
          return { content: [{ type: "text" as const, text: bounded.content + (bounded.truncated ? "\n[Receipt truncated; use web_read json.]" : "") }], details };
        }, combined);
      } catch (error) {
        // Never run fresh capture/eval after cancellation. Completed evidence stays useful.
        const failure = new Error(publicBrowserError(error));
        evidence.metadata.status = combined.aborted ? "cancelled" : "error";
        evidence.metadata.error = failure.message;
        try {
          const saved = await snapshots.save(evidence);
          failure.message += `\n${snapshotSummary(saved)}`;
          Object.assign(failure, { snapshot: saved.id });
        } catch { failure.message += "\nSnapshot unavailable: private storage could not retain this operation."; }
        throw failure;
      }
    },
  });

  return {
    tool, snapshots,
    getBrowserState: () => defaults.getState(),
    setBrowserOverride(value: BrowserKind | null): void {
      stopped.signal.throwIfAborted();
      defaults.setOverride(value);
    },
    async closeBrowser(remote = defaultRemote): Promise<void> {
      if (remote !== undefined) validateRemote(remote);
      return enqueue(remote, async () => {
        const session = browsers.get(remote);
        if (!session) throw new Error(`No browser is open for ${remote === undefined ? "local launch" : `remote ${remote}`}.`);
        browsers.delete(remote);
        await session.owner.close();
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopped.abort(new Error("Browser tools closed."));
      closing = (async () => {
        await Promise.allSettled(queues.values());
        const results = await Promise.allSettled([...browsers.values()].map(session => session.owner.close()));
        browsers.clear(); queues.clear();
        const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, "Browser cleanup failed");
      })();
      return closing;
    },
  };
}
