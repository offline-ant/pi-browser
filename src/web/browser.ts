import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TabClosed, type BrowserClient, type SharedTab } from "../broker/client.ts";
import { capturePage } from "../capture.ts";
import { publicBrowserError } from "../core/process.ts";
import { SnapshotStore, snapshotSummary, type SnapshotInfo, type SnapshotInput } from "../snapshots.ts";
import { abortable, validateWebUrl } from "./async.ts";
import { inspectionExpression, type PageInspection, type SearchResult } from "./extract.ts";
import type { AttentionHandler, WebSettings } from "./settings.ts";

export interface BrowserWebResult {
  output: string;
  url: string;
  title: string;
  tab: string;
  results?: SearchResult[];
  limitations: string[];
  snapshot?: SnapshotInfo;
  sourceCount?: number;
}

export function formatSearchResults(results: SearchResult[], compact = false): string {
  const escape = (value: string) => value.replace(/[\\`*_<>{}\[\]#|]/g, "\\$&");
  const excerpt = (value: string, maximum: number) => {
    const text = value.replace(/\s+/g, " ").trim();
    const characters = Array.from(text);
    return escape(compact && characters.length > maximum ? `${characters.slice(0, maximum).join("")}…` : text);
  };
  return results.length ? results.map((result, index) => `${index + 1}. [${excerpt(result.title, 200)}](<${result.url.replace(/[<>\\]/g, character => encodeURIComponent(character))}>)${result.snippet ? `\n   ${excerpt(result.snippet, 400)}` : ""}`).join("\n\n") : "The search engine reported no results.";
}

export class WebAttentionRequired extends Error {
  readonly tab: string;
  readonly url: string;
  constructor(reason: string, tab: string, url: string, headless = false) {
    super(`${reason} Research tab ${tab}: ${url}. ${headless
      ? "This browser is headless; no visible window is available for manual correction. Use a headed host to intervene, or a host-provided programmatic intervention handler."
      : "Leave this tab open and retry the same web operation after resolving it; retry resumes without navigating."}`);
    this.tab = tab;
    this.url = url;
  }
}

/** Research in auto-named tabs of the shared browser. No application/native bridge is installed in its pages. */
export class BrowserResearch {
  private readonly settings: WebSettings;
  private readonly client: BrowserClient;
  readonly snapshots: SnapshotStore;
  private readonly stopped = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  /** IDs of tabs awaiting human help, resumed by retrying the same operation. */
  private pending = new Map<string, string>();
  private closing?: Promise<void>;

  constructor(settings: WebSettings, client: BrowserClient, snapshots = new SnapshotStore()) {
    this.settings = settings;
    this.client = client;
    this.snapshots = snapshots;
  }

  run(kind: "search" | "fetch", value: string, maxResults: number, signal?: AbortSignal, attention?: AttentionHandler, progress?: (message: string) => void): Promise<BrowserWebResult> {
    const combined = signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal;
    combined.throwIfAborted();
    const previous = this.queue;
    const pending = this.execute(kind, value, maxResults, combined, attention, progress, previous);
    // A cancelled queued request must not release the queue ahead of its predecessor.
    this.queue = Promise.allSettled([previous, pending]);
    return pending;
  }

  /** Hold the tab left for this operation, if it is still open. Recovery happens only on a new call, never by silently repeating failed work. */
  private async resume(key: string, signal: AbortSignal, progress?: (message: string) => void): Promise<SharedTab | undefined> {
    const id = this.pending.get(key);
    if (id === undefined) return undefined;
    try { return (await this.client.open({ id }, signal)).tab; }
    catch (error) {
      if (!(error instanceof TabClosed)) throw error;
      this.pending.delete(key);
      progress?.("A previous research tab closed. Its operation cannot resume intact; this new call opens a fresh tab.");
      return undefined;
    }
  }

  private async execute(kind: "search" | "fetch", value: string, maxResults: number, signal: AbortSignal, attention: AttentionHandler | undefined, progress: ((message: string) => void) | undefined, previousCall: Promise<unknown>): Promise<BrowserWebResult> {
    let tab: SharedTab | undefined;
    const headless = this.client.headless;
    let inspectedPage: PageInspection | undefined;
    let captureAttempted = false;
    const evidence: SnapshotInput = { kind, metadata: { backend: "browser", ...(kind === "search" ? { query: value, searchEngine: this.settings.searchEngine, requestedCount: maxResults } : { url: value }) }, warnings: [] };
    const captureEvidence = async (): Promise<PageInspection> => {
      if (!tab || tab.closed) throw new Error("Research tab is unavailable for final capture.");
      captureAttempted = true;
      const capture = await capturePage(tab, { kind, engine: this.settings.searchEngine, signal });
      const inspection = this.inspection(capture.json);
      evidence.html = capture.html;
      evidence.md = capture.md;
      evidence.text = capture.text;
      evidence.json = capture.json;
      evidence.metadata.url = inspection.url;
      evidence.metadata.title = inspection.title;
      evidence.metadata.capturedAt = capture.capturedAt;
      evidence.warnings = [...capture.warnings];
      delete evidence.screenshot;
      delete evidence.metadata.screenshotCapturedAt;
      if (!signal.aborted) {
        try {
          // Other sessions share this browser; Chromium does not render a background tab for screenshots.
          await tab.focus();
          evidence.screenshot = await tab.screenshot();
          if (!evidence.screenshot) evidence.warnings.push("Screenshot unavailable: browser returned an empty image.");
          else evidence.metadata.screenshotCapturedAt = new Date().toISOString();
        } catch (error) { evidence.warnings.push(`Screenshot unavailable: ${publicBrowserError(error)}`); }
      }
      return inspection;
    };
    try {
      await abortable(previousCall, signal);
      signal.throwIfAborted();
      const key = `${kind}:${value}`;
      tab = await this.resume(key, signal, progress);
      let navigationError: unknown;
      if (!tab) {
        const address = kind === "fetch" ? value : this.searchUrl(value);
        progress?.(`Browser ${kind}: ${address}`);
        const opened = await this.client.open({ create: true, url: address }, signal);
        tab = opened.tab;
        evidence.metadata.browser = opened.browser;
        if (!headless) await tab.focus();
        signal.throwIfAborted();
        this.pending.set(key, tab.id);
        try { await tab.navigate(address, { signal, timeoutMs: 20_000 }); }
        catch (error) { signal.throwIfAborted(); navigationError = error; }
      } else {
        progress?.(`Resuming research tab ${tab.name} without navigation.`);
        if (!headless) await tab.focus();
      }
      evidence.metadata.tab = tab.name;
      const activeTab = tab;
      let deadline = Date.now() + 12_000;
      let earliest = Date.now() + 800;
      let stableSince = Date.now();
      let previous = "";
      const waitForUser = async (reason: string, url: string) => {
        if (!headless) await activeTab.focus();
        const request = { id: randomUUID(), reason: headless ? `${reason} The research browser is headless: no visible window is available; only a host-provided programmatic intervention can correct this live page.` : reason, url, tab: activeTab.name };
        progress?.(`Needs attention: ${request.reason} (${url})`);
        if (!attention) throw new WebAttentionRequired(reason, activeTab.name, url, headless);
        const continued = await abortable(Promise.resolve().then(() => attention(request, signal)), signal);
        signal.throwIfAborted();
        if (!continued) throw new WebAttentionRequired("Web operation cancelled; the page was left intact.", activeTab.name, url, headless);
        // Never replay navigation over a human's sign-in, challenge solution, or correction.
        deadline = Date.now() + 12_000;
        earliest = Date.now() + 800;
        previous = "";
        stableSince = Date.now();
        navigationError = undefined;
        captureAttempted = false;
      };
      for (;;) {
        signal.throwIfAborted();
        const inspected = await tab.evaluate(inspectionExpression(kind, this.settings.searchEngine), { signal, timeoutMs: 5_000 });
        const snapshot = this.inspection(inspected);
        inspectedPage = snapshot;
        if (!evidence.html) {
          evidence.metadata.url = snapshot.url;
          evidence.metadata.title = snapshot.title;
        }
        if (snapshot.attention) {
          await waitForUser(snapshot.attention, snapshot.url);
          continue;
        }
        if (snapshot.unsupported) throw new Error(`${snapshot.unsupported} Research tab ${tab.name}: ${snapshot.url}`);
        const signature = kind === "search" ? JSON.stringify(snapshot.results) : snapshot.markdown;
        if (signature !== previous) { previous = signature; stableSince = Date.now(); }
        const complete = snapshot.ready && (kind === "search" ? snapshot.results.length > 0 || snapshot.noResults : snapshot.markdown.length > 0);
        if (complete && Date.now() >= earliest && Date.now() - stableSince >= 400) {
          const final = await captureEvidence();
          signal.throwIfAborted();
          if (final.attention) {
            await waitForUser(final.attention, final.url);
            continue;
          }
          if (final.unsupported) throw new Error(`${final.unsupported} Research tab ${tab.name}: ${final.url}`);
          if (!final.ready || !(kind === "search" ? final.results.length > 0 || final.noResults : final.markdown.length > 0)) {
            captureAttempted = false;
            previous = "";
            stableSince = Date.now();
            if (Date.now() >= deadline) await waitForUser("Final page capture is still loading or unreadable. Inspect/correct the page manually.", final.url);
            await delay(200, undefined, { signal });
            continue;
          }
          const finalUrl = validateWebUrl(final.url);
          const results = final.results.slice(0, Math.min(maxResults, 20));
          evidence.metadata.status = "complete";
          if (kind === "search") {
            evidence.md = formatSearchResults(final.results);
            evidence.text = final.results.map(result => `${result.title}\n${result.url}\n${result.snippet}`).join("\n\n");
            evidence.metadata.sourceCount = final.results.length;
            evidence.metadata.returnedCount = results.length;
          }
          const saved = await this.snapshots.save(evidence);
          signal.throwIfAborted();
          this.pending.delete(key);
          return {
            url: finalUrl, title: final.title, tab: tab.name, limitations: saved.warnings, snapshot: saved,
            ...(kind === "search" ? { results, sourceCount: final.results.length } : {}),
            output: kind === "search" ? formatSearchResults(results, true) : evidence.md!,
          };
        }
        if (Date.now() >= deadline) {
          const reason = navigationError ? `Browser navigation failed: ${publicBrowserError(navigationError)}. Inspect/correct the page manually.` : kind === "search"
            ? "Search results did not become readable. This may be an unsupported layout, incomplete loading, or an undetected access check—not a confirmed empty search. Inspect/correct the page manually."
            : "Page content did not become readable. Inspect/correct the page manually; empty output is not a successful fetch.";
          await waitForUser(reason, snapshot.url);
          continue;
        }
        await delay(200, undefined, { signal });
      }
    } catch (error) {
      // Cancellation must not start new live evaluation; keep the last completed observation.
      if (!signal.aborted && !captureAttempted && tab && !tab.closed) {
        try { await captureEvidence(); }
        catch (captureError) { evidence.warnings!.push(`Page capture unavailable: ${publicBrowserError(captureError)}`); }
      } else if (signal.aborted) evidence.warnings!.push("Operation cancelled; no new live-page capture was attempted.");
      if (inspectedPage && !evidence.html) {
        evidence.json = { ...inspectedPage };
        evidence.md = inspectedPage.markdown;
        evidence.warnings!.push("No final capture completed; diagnostic content is from the last completed poll.", ...inspectedPage.limitations);
      }
      const reason = signal.aborted ? signal.reason : error;
      const failure = signal.aborted ? new Error(`${publicBrowserError(reason)}${error !== reason ? `; ${publicBrowserError(error)}` : ""}`) : error instanceof Error ? error : new Error(String(error));
      failure.message = publicBrowserError(error instanceof Error && !signal.aborted ? error : failure);
      evidence.metadata.status = "error";
      evidence.metadata.error = failure.message;
      const saved = await this.snapshots.save(evidence);
      failure.message += `\n${snapshotSummary(saved)}`;
      throw Object.assign(failure, { snapshot: saved });
    } finally { await tab?.release(); }
  }

  private searchUrl(query: string): string {
    const base = this.settings.searchEngine === "bing" ? "https://www.bing.com/search" : this.settings.searchEngine === "brave" ? "https://search.brave.com/search" : "https://duckduckgo.com/";
    const url = new URL(base);
    url.searchParams.set("q", query);
    return url.href;
  }

  private inspection(value: unknown): PageInspection {
    if (!value || typeof value !== "object") throw new Error("Browser content inspection did not return an object.");
    const result = value as Partial<PageInspection>;
    if (typeof result.url !== "string" || typeof result.title !== "string" || typeof result.markdown !== "string" || !Array.isArray(result.results) || !Array.isArray(result.limitations) || typeof result.ready !== "boolean" || typeof result.noResults !== "boolean") {
      throw new Error("Browser content inspection returned an invalid result.");
    }
    return result as PageInspection;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped.abort(new Error("Research browser closed."));
    this.closing = (async () => {
      await this.queue;
      this.pending.clear();
    })();
    return this.closing;
  }
}
