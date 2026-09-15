import path from "node:path";
import { defineTool, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { launchBrowser, type BrowserKind, type BrowserSession, type BrowserTab } from "./core/index.ts";
import { createBrowserDefault, type BrowserDefault } from "./browser-default.ts";
import { capturePage } from "./capture.ts";
import { publicBrowserError } from "./core/process.ts";
import { SnapshotStore, snapshotSummary, type SnapshotInput, type SnapshotFormat } from "./snapshots.ts";

export interface BrowserToolOptions {
  profileDir: string;
  artifactDir: string;
  browser?: BrowserKind;
  browserDefault?: BrowserDefault;
  snapshots?: SnapshotStore;
  headless?: boolean;
  executable?: string;
}

export interface BrowserResultDetails {
  session_id: string;
  browser: BrowserKind;
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

interface NamedBrowser {
  browser: BrowserKind;
  owner: BrowserSession;
  tab: BrowserTab;
}

/** Named live sessions produce immutable evidence readable without touching the browser. */
export function createBrowserTool(options: BrowserToolOptions) {
  const snapshots = options.snapshots ?? new SnapshotStore({ directory: options.artifactDir || undefined });
  const defaults = options.browserDefault ?? createBrowserDefault({ browser: options.browser });
  const executableBrowser = options.browser ?? defaults.getState().configured;
  const sessions = new Map<string, NamedBrowser>();
  const queues = new Map<string, Promise<unknown>>();
  const stopped = new AbortController();
  let starting = 0;
  let closing: Promise<void> | undefined;

  // Cancellation of a waiter never releases the running session's slot.
  function enqueue<T>(id: string, run: () => Promise<T>, signal = stopped.signal): Promise<T> {
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
    description: "Navigate a persistent named Chromium/Firefox tab and optionally evaluate JavaScript (async IIFEs; Promises awaited). Returns a compact receipt, small eval results/errors, and a snapshot ID. Use web_read for final md, text, html, json, screenshot, or before-screenshot. Only before-screenshot captures pre-eval state, after navigation; no other before formats exist. Large eval results live in snapshot JSON. Inspect HTML first, screenshots for visual evidence. Omit url to preserve the page. Existing sessions keep their engine. Headed by default; missing display is an error. Interrupted running eval closes the Chromium tab or named Firefox process; ordinary eval errors retain the session. Screenshot failures do not discard completed evaluation/content. Saved evidence is bounded and reports omissions.",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Named browser session, default 'default'. Scoped to this Pi session.", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$" })),
      browser: Type.Optional(StringEnum(["chromium", "firefox"] as const, { description: "Engine for a new session; omitted uses /browser-default or preserves an existing engine." })),
      url: Type.Optional(Type.String({ description: "HTTP(S) URL to navigate to before capture/eval. Omit to keep the current page." })),
      eval: Type.Optional(Type.String({ description: "JavaScript expression evaluated once; returned Promises are awaited." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const combined = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
      combined.throwIfAborted();
      const id = params.session_id ?? "default";
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id)) throw new Error("Invalid browser session_id.");
      if (params.browser !== undefined && params.browser !== "chromium" && params.browser !== "firefox") throw new Error("Invalid browser engine.");
      if (params.url !== undefined) {
        const url = new URL(params.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URL must be HTTP(S) without embedded credentials.");
      }
      const defaultBrowser = defaults.getState().effective;
      const evidence: SnapshotInput = { kind: "browser", metadata: { session_id: id, browser: params.browser ?? defaultBrowser,
        ...(params.url ? { requestedUrl: params.url } : {}), ...(params.eval !== undefined ? { expression: params.eval } : {}) }, warnings: [] };
      try {
        return await enqueue(id, async () => {
          combined.throwIfAborted();
          let session = sessions.get(id);
          if (session && params.browser && session.browser !== params.browser) throw new Error(`Session ${id} uses ${session.browser}; choose another session_id rather than closing its browser.`);
          const browser = session?.browser ?? params.browser ?? defaultBrowser;
          if (session?.owner.closed) {
            await session.owner.close();
            sessions.delete(id);
            session = undefined;
          }
          if (!session) {
            if (sessions.size + starting >= 8) throw new Error("Eight named browser sessions are already open or starting. Use /browser-close before opening another.");
            starting++;
            try {
              const owner = await launchBrowser({ browser, profileDir: path.join(options.profileDir, id, browser), headless: options.headless, executable: browser === executableBrowser ? options.executable : undefined });
              try {
                combined.throwIfAborted();
                session = { browser, owner, tab: await owner.openTab() };
                combined.throwIfAborted();
                sessions.set(id, session);
              } catch (error) { await owner.close(); throw error; }
            } finally { starting--; }
          } else if (session.tab.closed) session.tab = await session.owner.openTab();
          evidence.metadata.browser = session.browser;
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
            session_id: id, browser: session.browser, tab_id: session.tab.id, ...info,
            snapshot: saved.id, available: saved.available, truncated: preview?.truncated ?? false,
            ...(preview ? preview.truncated ? { eval_preview: preview.content } : { eval_result: evalResult ?? null } : {}),
            ...(evalError ? { eval_error: evalError } : {}),
          };
          const receipt = [`${snapshotSummary(saved)}`, `Session: ${id} (${session.browser})`,
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
    async closeSession(id: string): Promise<void> {
      return enqueue(id, async () => {
        const session = sessions.get(id);
        if (!session) throw new Error(`No browser session named ${id}.`);
        await session.owner.close();
        sessions.delete(id);
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopped.abort(new Error("Browser tools closed."));
      closing = (async () => {
        await Promise.allSettled(queues.values());
        const results = await Promise.allSettled([...sessions.values()].map(session => session.owner.close()));
        sessions.clear(); queues.clear();
        const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, "Browser cleanup failed");
      })();
      return closing;
    },
  };
}
