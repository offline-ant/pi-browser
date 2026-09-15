import { setTimeout as delay } from "node:timers/promises";
import { Cdp, object as cdpObject } from "./cdp.ts";
import { Bidi, object as bidiObject, remoteValue } from "./bidi.ts";
import { BrowserProcessLauncher, type NativeBrowserProcess } from "./process.ts";
import type { BrowserOptions, BrowserSession, BrowserTab, OperationOptions } from "./types.ts";

const DEFAULT_TIMEOUT = 15_000;

function navigationUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser navigation requires HTTP or HTTPS");
  return url.href;
}

function timeout(options: OperationOptions): number {
  const value = options.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Browser operation timeout must be positive");
  return value;
}

/** Interrupt only the wait unless the caller supplies a running-evaluation cleanup. */
async function interruptible<T>(run: () => Promise<T>, options: OperationOptions, interrupt?: () => Promise<void>): Promise<T> {
  options.signal?.throwIfAborted();
  const milliseconds = timeout(options);
  let rejectWait: (error: Error) => void = () => {};
  let interrupted: Error | undefined;
  let cleanup: Promise<void> | undefined;
  const stop = (message: string) => {
    if (interrupted) return;
    interrupted = new Error(message);
    cleanup = interrupt?.();
    // Install a handler immediately; a rejected cleanup must not be unhandled
    // while the interrupted operation unwinds.
    void cleanup?.catch(() => {});
    rejectWait(interrupted);
  };
  const abort = () => stop("Browser operation cancelled");
  const deadline = setTimeout(() => stop(`Browser operation timed out after ${milliseconds}ms`), milliseconds);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([run(), new Promise<never>((_resolve, reject) => { rejectWait = reject; })]);
  } catch (error) {
    if (interrupted) {
      try { await cleanup; }
      catch (cleanupError) { throw new Error(`${interrupted.message}; ${String(cleanupError)}`); }
      throw interrupted;
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
  }
}

class ResearchSession implements BrowserSession {
  private launcher: BrowserProcessLauncher;
  private runtime: NativeBrowserProcess;
  private cdp?: Cdp;
  private bidi?: Bidi;
  private initial?: string;
  private tabs = new Map<string, ResearchTab>();
  private closing?: Promise<void>;
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed || this.runtime.child.exitCode !== null || this.runtime.child.signalCode !== null || this.cdp?.closed === true || this.bidi?.closed === true;
  }

  constructor(launcher: BrowserProcessLauncher, runtime: NativeBrowserProcess) {
    this.launcher = launcher;
    this.runtime = runtime;
    runtime.child.once("exit", () => { void this.close().catch(() => {}); });
  }

  async initialize(): Promise<void> {
    if (this.runtime.kind === "chromium") {
      const cdp = await Cdp.connect(this.runtime.endpoint);
      this.cdp = cdp;
      cdp.onEvent((method, params) => {
        if (method === "Target.targetDestroyed" && typeof params.targetId === "string") this.destroyed(params.targetId);
      });
      await cdp.request("Target.setDiscoverTargets", { discover: true });
      const targets = await cdp.request("Target.getTargets");
      const initial = Array.isArray(targets.targetInfos)
        ? targets.targetInfos.map(cdpObject).find(target => target.type === "page" && target.url === "about:blank") : undefined;
      this.initial = typeof initial?.targetId === "string" ? initial.targetId : undefined;
    } else {
      const bidi = await Bidi.connect(this.runtime.endpoint);
      this.bidi = bidi;
      await bidi.request("session.new", { capabilities: {} });
      bidi.onEvent((method, params) => {
        if (method === "browsingContext.contextDestroyed" && typeof params.context === "string") this.destroyed(params.context);
      });
      await bidi.request("session.subscribe", { events: ["browsingContext.contextDestroyed", "browsingContext.domContentLoaded", "browsingContext.fragmentNavigated"] });
      const tree = await bidi.request("browsingContext.getTree");
      const initial = Array.isArray(tree.contexts)
        ? tree.contexts.map(bidiObject).find(context => context.parent === null && context.url === "about:blank") : undefined;
      this.initial = typeof initial?.context === "string" ? initial.context : undefined;
    }
  }

  private destroyed(id: string): void {
    this.tabs.get(id)?.dispose();
    this.tabs.delete(id);
  }

  async openTab(input?: string): Promise<BrowserTab> {
    const url = input === undefined ? undefined : navigationUrl(input);
    if (this.closed) throw new Error("The research browser is closed; open a new session");
    let id = this.initial;
    this.initial = undefined;
    let page: ResearchTab | undefined;
    let connection: Cdp | undefined;
    try {
      if (this.cdp) {
        id ??= String((await this.cdp.request("Target.createTarget", { url: "about:blank", background: false })).targetId);
        const endpoint = new URL(this.runtime.endpoint);
        const response = await fetch(`http://${endpoint.host}/json/list`, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`Chromium target lookup failed: ${response.status}`);
        const targets: unknown = await response.json();
        const target = Array.isArray(targets) ? targets.map(cdpObject).find(item => item.id === id) : undefined;
        if (typeof target?.webSocketDebuggerUrl !== "string") throw new Error("Owned Chromium tab has no debugging endpoint");
        connection = await Cdp.connect(target.webSocketDebuggerUrl);
        if (this.closed) throw new Error("The research browser closed while opening a tab");
        page = new ResearchTab(this, id, connection);
      } else if (this.bidi) {
        id ??= String((await this.bidi.request("browsingContext.create", { type: "tab", background: false })).context);
        if (this.closed) throw new Error("The research browser closed while opening a tab");
        page = new ResearchTab(this, id, undefined, this.bidi);
      } else throw new Error("Research browser transport is unavailable");
      this.tabs.set(id, page);
      await page.initialize();
      if (url) await page.navigate(url);
      return page;
    } catch (error) {
      connection?.close();
      page?.dispose();
      if (id) { this.tabs.delete(id); await this.closeNativeTab(id).catch(() => {}); }
      throw error;
    }
  }

  async closeTab(tab: ResearchTab): Promise<void> {
    if (this.tabs.get(tab.id) !== tab) return;
    this.tabs.delete(tab.id);
    tab.dispose();
    if (!this.closed) await this.closeNativeTab(tab.id);
  }

  private async closeNativeTab(id: string): Promise<void> {
    if (this.cdp) await this.cdp.request("Target.closeTarget", { targetId: id }, 2_000);
    else if (this.bidi) await this.bidi.request("browsingContext.close", { context: id }, 2_000);
  }

  /** Firefox cannot terminate running script in place; stop only this research process. */
  async stopForEvaluation(): Promise<void> {
    await this.close();
    throw new Error("Research Firefox stopped to terminate running JavaScript; all research tabs closed, saved profile retained");
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.isClosed = true;
    for (const page of this.tabs.values()) page.dispose();
    this.tabs.clear();
    this.closing = (async () => {
      // Closing the debugging socket or sending SIGTERM does not flush Chromium
      // cookies. Request normal browser shutdown and let the process finish first.
      const child = this.runtime.child;
      let onExit: () => void = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = new Promise<void>(resolve => {
        onExit = resolve;
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", onExit);
        timer = setTimeout(resolve, 3_000);
      });
      try {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            if (this.cdp) await this.cdp.request("Browser.close", {}, 2_000);
            else if (this.bidi) await this.bidi.request("browser.close", {}, 2_000);
          } catch { /* A normal shutdown can disconnect before replying. */ }
          await exited;
        }
      } finally {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        this.cdp?.close();
        this.bidi?.close();
        // A hung renderer must not prevent cancellation or retain the profile lease.
        await this.launcher.close();
      }
    })();
    return this.closing;
  }
}

class ResearchTab implements BrowserTab {
  readonly id: string;
  private session: ResearchSession;
  private cdp?: Cdp;
  private bidi?: Bidi;
  private unsubscribe?: () => void;
  private readyNavigations = new Set<string>();
  private frameId?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private isClosed = false;

  get closed(): boolean { return this.isClosed || this.session.closed || this.cdp?.closed === true; }

  constructor(session: ResearchSession, id: string, cdp?: Cdp, bidi?: Bidi) {
    this.session = session;
    this.id = id;
    this.cdp = cdp;
    this.bidi = bidi;
  }

  async initialize(): Promise<void> {
    if (this.cdp) {
      this.unsubscribe = this.cdp.onEvent((method, params) => {
        if (method === "Page.lifecycleEvent" && params.frameId === this.frameId && params.name === "DOMContentLoaded" && typeof params.loaderId === "string") {
          this.readyNavigations.add(params.loaderId);
          if (this.readyNavigations.size > 32) this.readyNavigations.delete(this.readyNavigations.values().next().value!);
        }
      });
      await this.cdp.request("Page.enable");
      const tree = await this.cdp.request("Page.getFrameTree");
      this.frameId = String(cdpObject(cdpObject(tree.frameTree).frame).id);
      await this.cdp.request("Page.setLifecycleEventsEnabled", { enabled: true });
      await this.cdp.request("Runtime.enable");
    } else if (this.bidi) {
      this.unsubscribe = this.bidi.onEvent((method, params) => {
        if ((method === "browsingContext.domContentLoaded" || method === "browsingContext.fragmentNavigated") && params.context === this.id && typeof params.navigation === "string") {
          this.readyNavigations.add(params.navigation);
          if (this.readyNavigations.size > 32) this.readyNavigations.delete(this.readyNavigations.values().next().value!);
        }
      });
    }
  }

  dispose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.unsubscribe?.();
    this.cdp?.close();
  }

  private assertOpen(): void {
    if (this.closed || this.session.closed) throw new Error("The research tab is closed");
  }

  private operation<T>(run: (options: OperationOptions) => Promise<T>, options: OperationOptions = {}): Promise<T> {
    let milliseconds: number;
    try { this.assertOpen(); options.signal?.throwIfAborted(); milliseconds = timeout(options); }
    catch (error) { return Promise.reject(error); }
    const deadline = Date.now() + milliseconds;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    const waiting = new Promise<never>((_resolve, reject) => {
      abort = () => { expired = true; reject(options.signal?.reason ?? new Error("Browser operation cancelled while queued")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { expired = true; reject(new Error(`Browser operation timed out after ${milliseconds}ms while queued`)); }, milliseconds);
    });
    const clearWaiting = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    const operation = this.queue.then(() => {
      clearWaiting();
      if (expired) throw new Error("Browser operation expired while queued; it was not executed");
      this.assertOpen();
      options.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Browser operation timed out after ${milliseconds}ms while queued`);
      return run({ ...options, timeoutMs: remaining });
    });
    this.queue = operation.catch(() => {});
    return Promise.race([operation, waiting]).finally(clearWaiting);
  }

  navigate(input: string, options: OperationOptions = {}): Promise<void> {
    let url: string;
    try { url = navigationUrl(input); } catch (error) { return Promise.reject(error); }
    return this.operation(effective => interruptible(async () => {
      const milliseconds = timeout(effective);
      const deadline = Date.now() + milliseconds;
      let navigation: unknown;
      if (this.cdp) {
        const response = await this.cdp.request("Page.navigate", { url }, milliseconds);
        if (response.errorText) throw new Error(`Browser navigation failed: ${String(response.errorText)}`);
        navigation = response.loaderId;
      } else {
        const response = await this.bidi!.request("browsingContext.navigate", { context: this.id, url, wait: "none" }, milliseconds);
        navigation = response.navigation;
      }
      // CDP omits the loader for same-document navigation; BiDi supplies a
      // navigation ID and signals readiness with fragmentNavigated instead.
      if (typeof navigation !== "string") return;
      while (!this.readyNavigations.has(navigation)) {
        this.assertOpen();
        options.signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error(`Browser navigation timed out after ${milliseconds}ms`);
        await delay(20);
      }
    }, effective), options);
  }

  evaluate(expression: string, options: OperationOptions = {}): Promise<unknown> {
    return this.operation(effective => this.runEvaluation(expression, effective), options);
  }

  private async runEvaluation(expression: string, options: OperationOptions): Promise<unknown> {
    return interruptible(async () => {
      const milliseconds = timeout(options);
      if (this.cdp) {
        const response = await this.cdp.request("Runtime.evaluate", {
          expression, awaitPromise: true, returnByValue: true,
        }, milliseconds + 3_000);
        if (response.exceptionDetails) {
          const exception = cdpObject(response.exceptionDetails);
          const description = cdpObject(exception.exception).description;
          throw new Error(String(description ?? exception.text ?? "Browser JavaScript evaluation failed"));
        }
        const value = cdpObject(response.result);
        if ("value" in value) return value.value;
        if (value.type === "undefined") return undefined;
        if ("unserializableValue" in value) return { type: value.type, value: value.unserializableValue };
        return { type: value.subtype ?? value.type, description: value.description };
      }
      const response = await this.bidi!.request("script.evaluate", {
        expression, target: { context: this.id }, awaitPromise: true, resultOwnership: "none",
        serializationOptions: { maxObjectDepth: 30, maxDomDepth: 0 },
      }, milliseconds + 3_000);
      if (response.type === "exception") throw new Error(String(bidiObject(response.exceptionDetails).text ?? "Browser JavaScript evaluation failed"));
      return bidiObject(response.result).type === "undefined" ? undefined : remoteValue(response.result);
    }, options, async () => {
      if (!this.cdp) return this.session.stopForEvaluation();
      // terminateExecution only interrupts the current stack. An awaited Promise
      // can still resume later, so destroy the interrupted execution context.
      try { await this.close(); }
      catch {
        await this.session.close();
        throw new Error("Research Chromium stopped because closing the interrupted tab failed; all research tabs closed");
      }
      throw new Error("Research Chromium tab closed to terminate running JavaScript; other research tabs retained");
    });
  }

  async info(): Promise<{ url: string; title: string }> {
    const value = await this.evaluate("({url:location.href,title:document.title})");
    const info = cdpObject(value);
    if (typeof info.url !== "string" || typeof info.title !== "string") throw new Error("Browser did not return page metadata");
    return { url: info.url, title: info.title };
  }

  async html(): Promise<string> {
    const value = await this.evaluate("(() => { const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\\n' : ''; return doctype + document.documentElement.outerHTML; })()");
    if (typeof value !== "string") throw new Error("Browser did not return HTML");
    return value;
  }

  screenshot(): Promise<string> {
    return this.operation(async () => {
      const result = this.cdp
        ? await this.cdp.request("Page.captureScreenshot", { format: "png", fromSurface: true })
        : await this.bidi!.request("browsingContext.captureScreenshot", { context: this.id });
      if (typeof result.data !== "string") throw new Error("Browser did not return a screenshot");
      return result.data;
    });
  }

  focus(): Promise<void> {
    return this.operation(async () => {
      if (this.cdp) await this.cdp.request("Page.bringToFront");
      else await this.bidi!.request("browsingContext.activate", { context: this.id });
    });
  }

  close(): Promise<void> { return this.session.closeTab(this); }
}

export async function launchBrowser(options: BrowserOptions): Promise<BrowserSession> {
  const launcher = await BrowserProcessLauncher.create(options);
  let browser: ResearchSession | undefined;
  try {
    const runtime = await launcher.start();
    browser = new ResearchSession(launcher, runtime);
    await browser.initialize();
    return browser;
  } catch (error) {
    if (browser) await browser.close();
    else await launcher.close();
    throw error;
  }
}
