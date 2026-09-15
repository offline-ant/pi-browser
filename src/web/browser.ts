import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchBrowser, type BrowserSession, type BrowserTab } from "../core/index.ts";
import { capturePage } from "../capture.ts";
import { publicBrowserError } from "../core/process.ts";
import { SnapshotStore, snapshotSummary, type SnapshotInfo, type SnapshotInput } from "../snapshots.ts";
import { abortable, validateWebUrl } from "./async.ts";
import { inspectionExpression, type PageInspection, type SearchResult } from "./extract.ts";
import type { AttentionHandler, WebSettings } from "./settings.ts";

const MAX_TABS = 8;
const RECENT_TABS = 3;

export interface BrowserWebResult {
  output: string;
  url: string;
  title: string;
  tabId: string;
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
  readonly tabId: string;
  readonly url: string;
  constructor(reason: string, tabId: string, url: string, headless = false) {
    super(`${reason} Research tab ${tabId}: ${url}. ${headless
      ? "This browser is headless; no visible window is available for manual correction. Use a headed host to intervene, or a host-provided programmatic intervention handler."
      : "Leave this tab open and retry the same web operation after resolving it; retry resumes without navigating."}`);
    this.tabId = tabId;
    this.url = url;
  }
}

/** A separate owned research process. No application/native bridge is installed in its pages. */
export class BrowserResearch {
  private readonly settings: WebSettings;
  private readonly launch: typeof launchBrowser;
  readonly snapshots: SnapshotStore;
  private readonly stopped = new AbortController();
  private browser?: Promise<BrowserSession>;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, BrowserTab>();
  private recent: BrowserTab[] = [];
  private closing?: Promise<void>;

  constructor(settings: WebSettings, launch: typeof launchBrowser = launchBrowser, snapshots = new SnapshotStore()) {
    this.settings = settings;
    this.launch = launch;
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

  /** Recovery is performed only on a new call, never by silently repeating failed work. */
  private async reconcile(signal: AbortSignal, progress?: (message: string) => void): Promise<void> {
    if (this.browser) {
      const browser = await abortable(this.browser, signal);
      if (browser.closed) {
        // Finish the old process/profile cleanup before attempting another launch.
        await browser.close();
        this.browser = undefined;
        this.pending.clear();
        this.recent = [];
        progress?.("The previous research browser closed. This new call will open a fresh browser/tab; unsaved research pages cannot be resumed.");
        return;
      }
    }
    let lostPending = false;
    for (const [key, tab] of this.pending) {
      if (tab.closed) { this.pending.delete(key); lostPending = true; }
    }
    this.recent = this.recent.filter(tab => !tab.closed);
    if (lostPending) progress?.("A previous research tab closed. Its operation cannot resume intact; this new call will open a fresh tab if needed. Other research tabs are retained.");
  }

  private async reserveTab(): Promise<void> {
    while (this.pending.size + this.recent.length >= MAX_TABS && this.recent.length) await this.recent.shift()!.close();
    if (this.pending.size >= MAX_TABS) {
      throw new Error(`All ${MAX_TABS} research tabs have unfinished operations. Resolve/retry an existing operation or close one of its browser tabs before starting another; pending intervention pages will not be discarded.`);
    }
  }

  private async execute(kind: "search" | "fetch", value: string, maxResults: number, signal: AbortSignal, attention: AttentionHandler | undefined, progress: ((message: string) => void) | undefined, previousCall: Promise<unknown>): Promise<BrowserWebResult> {
    let tab: BrowserTab | undefined;
    let inspectedPage: PageInspection | undefined;
    let captureAttempted = false;
    const evidence: SnapshotInput = { kind, metadata: { backend: "browser", browser: this.settings.browser, ...(kind === "search" ? { query: value, searchEngine: this.settings.searchEngine, requestedCount: maxResults } : { url: value }) }, warnings: [] };
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
      await this.reconcile(signal, progress);
      signal.throwIfAborted();
      const key = `${kind}:${value}`;
      tab = this.pending.get(key);
      let navigationError: unknown;
      if (!tab) {
        const address = kind === "fetch" ? value : this.searchUrl(value);
        progress?.(`Browser ${kind}: ${address}`);
        signal.throwIfAborted();
        await this.reserveTab();
        signal.throwIfAborted();
        if (!this.browser) {
          const starting = this.launch({ browser: this.settings.browser, profileDir: path.join(this.settings.profileDir, this.settings.browser), headless: this.settings.headless, executable: this.settings.executable });
          this.browser = starting;
          void starting.catch(() => { if (this.browser === starting) this.browser = undefined; });
        }
        const browser = await abortable(this.browser, signal);
        signal.throwIfAborted();
        tab = await browser.openTab();
        try {
          if (!this.settings.headless) await tab.focus();
          signal.throwIfAborted();
        } catch (error) {
          // No navigation has started: do not advertise an empty tab as resumable.
          await tab.close();
          throw error;
        }
        this.pending.set(key, tab);
        try { await tab.navigate(address, { signal, timeoutMs: 20_000 }); }
        catch (error) { signal.throwIfAborted(); navigationError = error; }
      } else {
        progress?.(`Resuming research tab ${tab.id} without navigation.`);
        if (!this.settings.headless) await tab.focus();
      }
      evidence.metadata.tabId = tab.id;
      const activeTab = tab;
      let deadline = Date.now() + 12_000;
      let earliest = Date.now() + 800;
      let stableSince = Date.now();
      let previous = "";
      const waitForUser = async (reason: string, url: string) => {
        if (!this.settings.headless) await activeTab.focus();
        const request = { id: randomUUID(), reason: this.settings.headless ? `${reason} The research browser is headless: no visible window is available; only a host-provided programmatic intervention can correct this live page.` : reason, url, tabId: activeTab.id };
        progress?.(`Needs attention: ${request.reason} (${url})`);
        if (!attention) throw new WebAttentionRequired(reason, activeTab.id, url, this.settings.headless);
        const continued = await abortable(Promise.resolve().then(() => attention(request, signal)), signal);
        signal.throwIfAborted();
        if (!continued) throw new WebAttentionRequired("Web operation cancelled; the page was left intact.", activeTab.id, url, this.settings.headless);
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
        if (snapshot.unsupported) throw new Error(`${snapshot.unsupported} Research tab ${tab.id}: ${snapshot.url}`);
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
          if (final.unsupported) throw new Error(`${final.unsupported} Research tab ${tab.id}: ${final.url}`);
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
          this.recent.push(tab);
          while (this.recent.length > RECENT_TABS) await this.recent.shift()!.close();
          return {
            url: finalUrl, title: final.title, tabId: tab.id, limitations: saved.warnings, snapshot: saved,
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
    }
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
      this.recent = [];
      await (await this.browser?.catch(() => undefined))?.close();
    })();
    return this.closing;
  }
}
