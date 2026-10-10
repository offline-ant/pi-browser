import { setTimeout as delay } from "node:timers/promises";
import { object as cdpObject, type CdpSession } from "./cdp.ts";
import { Bidi, object as bidiObject, remoteValue } from "./bidi.ts";
import type { BrowserConnection } from "./session.ts";
import type { BrowserTab, OperationOptions } from "./types.ts";

const DEFAULT_TIMEOUT = 15_000;

/** The page's JavaScript threw or rejected; the tab and its document remain usable. */
export class ScriptError extends Error {}

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

export class ProtocolTab implements BrowserTab {
  readonly id: string;
  private session: BrowserConnection;
  private cdp?: CdpSession;
  private bidi?: Bidi;
  private unsubscribe?: () => void;
  /** Loaded navigations; for Chromium, each maps to its document's main-world context at DOMContentLoaded. */
  private readyNavigations = new Map<string, string | undefined>();
  private context?: string;
  private frameId?: string;
  private markClosed: () => void = () => {};
  /** Resolves once the tab closes: manual or explicit closure, destructive interruption, or session closure. */
  readonly whenClosed = new Promise<void>(resolve => { this.markClosed = resolve; });
  private queue: Promise<unknown> = Promise.resolve();
  private isClosed = false;

  get closed(): boolean { return this.isClosed || this.session.closed || this.cdp?.closed === true; }

  constructor(session: BrowserConnection, id: string, cdp?: CdpSession, bidi?: Bidi) {
    this.session = session;
    this.id = id;
    this.cdp = cdp;
    this.bidi = bidi;
  }

  async initialize(): Promise<void> {
    if (this.cdp) {
      this.unsubscribe = this.cdp.onEvent((method, params) => {
        // Target events arrive in renderer order: at a navigation's DOMContentLoaded the current
        // main-world context belongs to that navigation's document.
        if (method === "Page.lifecycleEvent" && params.frameId === this.frameId && params.name === "DOMContentLoaded" && typeof params.loaderId === "string") {
          this.ready(params.loaderId, this.context);
        } else if (method === "Runtime.executionContextCreated") {
          const context = cdpObject(params.context);
          const aux = cdpObject(context.auxData);
          if (aux.frameId === this.frameId && aux.isDefault === true && typeof context.uniqueId === "string") this.context = context.uniqueId;
        } else if (method === "Runtime.executionContextsCleared"
          || method === "Runtime.executionContextDestroyed" && params.executionContextUniqueId === this.context) this.context = undefined;
      });
      await this.cdp.request("Page.enable");
      const tree = await this.cdp.request("Page.getFrameTree");
      this.frameId = String(cdpObject(cdpObject(tree.frameTree).frame).id);
      await this.cdp.request("Page.setLifecycleEventsEnabled", { enabled: true });
      await this.cdp.request("Runtime.enable");
    } else if (this.bidi) {
      this.unsubscribe = this.bidi.onEvent((method, params) => {
        if ((method === "browsingContext.domContentLoaded" || method === "browsingContext.fragmentNavigated") && params.context === this.id && typeof params.navigation === "string") {
          this.ready(params.navigation, undefined);
        }
      });
    }
  }

  private ready(navigation: string, context: string | undefined): void {
    this.readyNavigations.set(navigation, context);
    if (this.readyNavigations.size > 32) this.readyNavigations.delete(this.readyNavigations.keys().next().value!);
  }

  dispose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.unsubscribe?.();
    this.cdp?.close();
    this.markClosed();
  }

  private assertOpen(): void {
    if (this.closed || this.session.closed) throw new Error("The browser tab is closed");
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
      try {
        const milliseconds = timeout(options);
        if (this.cdp) {
          const response = await this.cdp.request("Runtime.evaluate", {
            expression, awaitPromise: true, returnByValue: true,
            ...(options.document === undefined ? {} : { uniqueContextId: options.document }),
          }, milliseconds + 3_000);
          if (response.exceptionDetails) {
            const exception = cdpObject(response.exceptionDetails);
            const description = cdpObject(exception.exception).description;
            throw new ScriptError(String(description ?? exception.text ?? "Browser JavaScript evaluation failed"));
          }
          const value = cdpObject(response.result);
          if ("value" in value) return value.value;
          if (value.type === "undefined") return undefined;
          if ("unserializableValue" in value) return { type: value.type, value: value.unserializableValue };
          return { type: value.subtype ?? value.type, description: value.description };
        }
        if (options.document !== undefined) throw new Error("Document-bound evaluation requires Chromium");
        const response = await this.bidi!.request("script.evaluate", {
          expression, target: { context: this.id }, awaitPromise: true, resultOwnership: "none",
          serializationOptions: { maxObjectDepth: 30, maxDomDepth: 0 },
        }, milliseconds + 3_000);
        if (response.type === "exception") throw new ScriptError(String(bidiObject(response.exceptionDetails).text ?? "Browser JavaScript evaluation failed"));
        return bidiObject(response.result).type === "undefined" ? undefined : remoteValue(response.result);
      } catch (error) {
        if (this.session.attached && (this.cdp?.closed || this.bidi?.closed)) {
          throw new Error(`${String(error)}; attached debugging connection was lost; JavaScript may continue running. The external browser was not stopped`, { cause: error });
        }
        throw error;
      }
    }, options, () => this.session.interruptEvaluation(this));
  }

  /** Chromium: the current document's identity and URL, read from the browser protocol rather than page JavaScript. */
  document(): Promise<{ id: string; url: string }> {
    return this.operation(async () => this.currentDocument());
  }

  private async currentDocument(): Promise<{ id: string; url: string }> {
    if (!this.cdp) throw new Error("Document identity requires Chromium");
    const frame = cdpObject(cdpObject((await this.cdp.request("Page.getFrameTree")).frameTree).frame);
    const id = typeof frame.loaderId === "string" ? this.readyNavigations.get(frame.loaderId) : undefined;
    if (!id || typeof frame.url !== "string") throw new Error("The page document is not loaded");
    return { id, url: frame.url + (typeof frame.urlFragment === "string" ? frame.urlFragment : "") };
  }

  /** Chromium: reloads the page and resolves the new document once its DOM is loaded. */
  reload(options: OperationOptions = {}): Promise<{ id: string; url: string }> {
    if (!this.cdp) return Promise.reject(new Error("Reload requires Chromium"));
    const cdp = this.cdp;
    return this.operation(effective => interruptible(async () => {
      const deadline = Date.now() + timeout(effective);
      let unsubscribe = () => {};
      let loader: string | undefined;
      try {
        unsubscribe = cdp.onEvent((method, params) => {
          const frame = cdpObject(params.frame);
          if (method === "Page.frameNavigated" && frame.id === this.frameId && typeof frame.loaderId === "string") loader = frame.loaderId;
        });
        await cdp.request("Page.reload", {}, timeout(effective));
        while (loader === undefined || !this.readyNavigations.has(loader)) {
          this.assertOpen();
          if (Date.now() >= deadline) throw new Error("Browser reload timed out");
          await delay(20);
        }
      } finally { unsubscribe(); }
      return this.currentDocument();
    }, effective), options);
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

  /** Chromium cannot close a page whose script never yields; stop the script first. Firefox closes it directly. */
  async terminateExecution(): Promise<void> {
    await this.cdp?.request("Runtime.terminateExecution", {}, 2_000);
  }

  close(): Promise<void> { return this.session.closeTab(this); }
}
