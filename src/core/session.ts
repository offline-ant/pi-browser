import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Cdp, object as cdpObject } from "./cdp.ts";
import { Bidi, BidiCommandError, object as bidiObject } from "./bidi.ts";
import { BrowserProcessLauncher, type NativeBrowserProcess } from "./process.ts";
import { ProtocolTab } from "./tab.ts";
import type { BrowserKind, BrowserConnectOptions, BrowserOptions, BrowserSession, BrowserTab } from "./types.ts";

interface OwnedProcess { launcher: BrowserProcessLauncher; runtime: NativeBrowserProcess; }

/** Protocol connection ownership is independent from browser-process ownership. */
export class BrowserConnection implements BrowserSession {
  private kind: BrowserKind;
  private endpoint: string;
  private owned?: OwnedProcess;
  private cdp?: Cdp;
  private bidi?: Bidi;
  private bidiSession = false;
  /** A launched browser's first blank tab anchors its window: never handed out, listed, or closed, so closing any
   * opened tab is never closing the last one (Firefox refuses that; Chromium can exit). */
  private initial?: string;
  private tabs = new Map<string, ProtocolTab>();
  private tabIds = new Set<string>();
  private opening = new Set<Promise<BrowserTab>>();
  private attaching = new Map<string, Promise<ProtocolTab>>();
  private closing?: Promise<void>;
  private isClosed = false;

  get attached(): boolean { return !this.owned; }

  get browser(): BrowserKind { return this.kind; }

  get closed(): boolean {
    const child = this.owned?.runtime.child;
    return this.isClosed || !!child && (child.exitCode !== null || child.signalCode !== null) || this.cdp?.closed === true || this.bidi?.closed === true;
  }

  constructor(kind: BrowserKind, endpoint: string, owned?: OwnedProcess) {
    this.kind = kind;
    this.endpoint = endpoint;
    this.owned = owned;
    owned?.runtime.child.once("exit", () => { void this.close().catch(() => {}); });
  }

  async initialize(signal?: AbortSignal, socketPath?: string): Promise<void> {
    signal?.throwIfAborted();
    if (this.kind === "chromium") {
      const cdp = await Cdp.connect(this.endpoint, signal, socketPath);
      this.cdp = cdp;
      signal?.throwIfAborted();
      cdp.onEvent((method, params) => {
        if (method === "Target.targetDestroyed" && typeof params.targetId === "string") this.destroyed(params.targetId);
      });
      await cdp.request("Target.setDiscoverTargets", { discover: true }, 5_000);
      signal?.throwIfAborted();
      if (this.owned) {
        const targets = await cdp.request("Target.getTargets", {}, 5_000);
        const initial = Array.isArray(targets.targetInfos)
          ? targets.targetInfos.map(cdpObject).find(target => target.type === "page" && target.url === "about:blank") : undefined;
        this.initial = typeof initial?.targetId === "string" ? initial.targetId : undefined;
      }
    } else {
      const bidi = await Bidi.connect(this.endpoint, 5_000, signal, socketPath);
      this.bidi = bidi;
      signal?.throwIfAborted();
      // Even if the reply is lost, session.end on THIS connection can only end
      // a session created on it. A rejected session.new leaves it sessionless.
      this.bidiSession = true;
      try {
        const result = await bidi.request("session.new", { capabilities: {} }, 5_000);
        if (typeof result.sessionId !== "string" || !result.sessionId) throw new Error("Firefox session.new returned no valid session ID");
      }
      catch (error) {
        if (error instanceof BidiCommandError) this.bidiSession = false;
        throw error;
      }
      signal?.throwIfAborted();
      bidi.onEvent((method, params) => {
        if (method === "browsingContext.contextDestroyed" && typeof params.context === "string") this.destroyed(params.context);
      });
      await bidi.request("session.subscribe", { events: ["browsingContext.contextDestroyed", "browsingContext.domContentLoaded", "browsingContext.fragmentNavigated"] }, 5_000);
      signal?.throwIfAborted();
      if (this.owned) {
        const tree = await bidi.request("browsingContext.getTree", {}, 5_000);
        const initial = Array.isArray(tree.contexts)
          ? tree.contexts.map(bidiObject).find(context => context.parent === null && context.url === "about:blank") : undefined;
        this.initial = typeof initial?.context === "string" ? initial.context : undefined;
      }
    }
    signal?.throwIfAborted();
  }

  private destroyed(id: string): void {
    this.tabs.get(id)?.dispose();
    this.tabs.delete(id);
    this.tabIds.delete(id);
  }

  openTab(input?: string): Promise<BrowserTab> {
    const opening = this.createTab(input);
    this.opening.add(opening);
    void opening.finally(() => this.opening.delete(opening)).catch(() => {});
    return opening;
  }

  private async createTab(input?: string): Promise<BrowserTab> {
    if (input !== undefined) {
      const url = new URL(input);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser navigation requires HTTP or HTTPS");
    }
    if (this.closed) throw new Error("The browser connection is closed; open a new session");
    let id: string | undefined;
    try {
      if (this.cdp) {
        const result = await this.cdp.request("Target.createTarget", { url: "about:blank", background: false });
        if (typeof result.targetId !== "string") throw new Error("Chromium did not return a new target ID");
        id = result.targetId;
      } else if (this.bidi) {
        const result = await this.bidi.request("browsingContext.create", { type: "tab", background: false });
        if (typeof result.context !== "string") throw new Error("Firefox did not return a new browsing context");
        id = result.context;
      }
      if (!id) throw new Error("Browser transport is unavailable");
      this.tabIds.add(id);
      const page = await this.attach(id);
      if (input) await page.navigate(input);
      if (this.closed) throw new Error("The browser connection closed while opening a tab");
      return page;
    } catch (error) {
      if (id) { this.tabs.get(id)?.dispose(); this.tabs.delete(id); await this.closeNativeTab(id).catch(() => {}); }
      throw error;
    }
  }

  /** Top-level pages, including tabs opened by people or pages. The anchor tab is excluded. */
  async pages(): Promise<{ id: string; url: string; title?: string }[]> {
    if (this.closed) throw new Error("The browser connection is closed; open a new session");
    if (this.cdp) {
      const result = await this.cdp.request("Target.getTargets", {}, 5_000);
      return (Array.isArray(result.targetInfos) ? result.targetInfos.map(cdpObject) : [])
        .filter(target => target.type === "page" && typeof target.targetId === "string" && target.targetId !== this.initial
          && typeof target.url === "string" && !target.url.startsWith("devtools://"))
        .map(target => ({ id: target.targetId as string, url: target.url as string, title: typeof target.title === "string" ? target.title : "" }));
    }
    const tree = await this.bidi!.request("browsingContext.getTree", { maxDepth: 0 }, 5_000);
    return (Array.isArray(tree.contexts) ? tree.contexts.map(bidiObject) : [])
      .filter(context => typeof context.context === "string" && context.context !== this.initial && typeof context.url === "string")
      .map(context => ({ id: context.context as string, url: context.url as string }));
  }

  /** Use an existing page from pages(). Attaching does not make it owned: close() leaves it open. */
  tab(id: string): Promise<BrowserTab> {
    const existing = this.tabs.get(id);
    if (existing && !existing.closed) return Promise.resolve(existing);
    let attaching = this.attaching.get(id);
    if (!attaching) {
      attaching = this.attach(id);
      this.attaching.set(id, attaching);
      void attaching.finally(() => this.attaching.delete(id)).catch(() => {});
    }
    return attaching;
  }

  private async attach(id: string): Promise<ProtocolTab> {
    if (this.closed) throw new Error("The browser connection closed while opening a tab");
    let page: ProtocolTab;
    if (this.cdp) {
      const attached = await this.cdp.request("Target.attachToTarget", { targetId: id, flatten: true });
      if (typeof attached.sessionId !== "string") throw new Error("Chromium did not return a target session ID");
      page = new ProtocolTab(this, id, this.cdp.session(attached.sessionId));
    } else if (this.bidi) page = new ProtocolTab(this, id, undefined, this.bidi);
    else throw new Error("Browser transport is unavailable");
    this.tabs.set(id, page);
    try {
      if (this.closed) throw new Error("The browser connection closed while opening a tab");
      await page.initialize();
      return page;
    } catch (error) {
      page.dispose();
      this.tabs.delete(id);
      throw error;
    }
  }

  async closeTab(tab: ProtocolTab): Promise<void> {
    if (this.tabs.get(tab.id) !== tab) return;
    tab.dispose();
    try {
      if (!this.closed) await this.closeNativeTab(tab.id);
      else throw new Error("Browser connection was lost before tab closure could be confirmed");
    } finally { this.tabs.delete(tab.id); }
  }

  private async closeNativeTab(id: string): Promise<void> {
    if (this.cdp) {
      // closeTarget succeeds before the target is gone; a page listing must not still report a closed tab.
      let unsubscribe = () => {};
      const destroyed = new Promise<void>(resolve => {
        unsubscribe = this.cdp!.onEvent((method, params) => { if (method === "Target.targetDestroyed" && params.targetId === id) resolve(); });
      });
      try {
        const result = await this.cdp.request("Target.closeTarget", { targetId: id }, 2_000);
        if (result.success !== true) throw new Error("Chromium did not confirm tab closure");
        await Promise.race([destroyed, delay(2_000)]);
      } finally { unsubscribe(); }
    } else if (this.bidi) await this.bidi.request("browsingContext.close", { context: id }, 2_000);
    this.tabIds.delete(id);
  }

  async interruptEvaluation(tab: ProtocolTab): Promise<void> {
    try {
      await tab.terminateExecution();
      await tab.close();
    }
    catch {
      await this.close().catch(() => {});
      if (!this.owned) throw new Error("Attached browser disconnected because tab closure could not be confirmed; JavaScript may continue running. The external browser was not stopped");
      throw new Error(`${this.label} stopped because closing the interrupted tab failed; all its tabs closed`);
    }
    throw new Error(`${this.label} tab closed to terminate running JavaScript; other tabs retained`);
  }

  private get label(): string { return this.kind === "chromium" ? "Chromium" : "Firefox"; }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.isClosed = true;
    this.closing = (async () => {
      // Keep the transport alive until late creation/attachment replies can be
      // accounted for. No new open may start after isClosed was set.
      await Promise.allSettled([...this.opening]);
      for (const page of this.tabs.values()) page.dispose();
      this.tabs.clear();
      if (this.owned) await this.closeOwned(this.owned);
      else await this.closeAttached([...this.tabIds]);
    })();
    return this.closing;
  }

  private async closeAttached(ids: string[]): Promise<void> {
    const errors: unknown[] = [];
    try {
      const results = await Promise.allSettled(ids.map(id => this.closeNativeTab(id)));
      errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
      if (this.bidiSession && this.bidi) {
        try {
          if (this.bidi.closed) throw new Error("Firefox disconnected before automation session closure could be confirmed");
          await this.bidi.request("session.end", {}, 2_000);
          this.bidiSession = false;
        }
        catch (error) { errors.push(error); }
      }
    } finally { this.cdp?.close(); this.bidi?.close(); }
    if (errors.length) throw new AggregateError(errors, "Attached browser disconnected; some owned tabs or the automation session could not be confirmed closed. The external browser was not stopped");
  }

  private async closeOwned(owned: OwnedProcess): Promise<void> {
    // Normal browser shutdown flushes profile cookies before process cleanup.
    const child = owned.runtime.child;
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
        } catch { /* Normal shutdown can disconnect before replying. */ }
        await exited;
      }
    } finally {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      this.cdp?.close();
      this.bidi?.close();
      await owned.launcher.close();
    }
  }
}

export async function launchBrowser(options: BrowserOptions): Promise<BrowserSession> {
  const launcher = await BrowserProcessLauncher.create(options);
  let browser: BrowserConnection | undefined;
  try {
    const runtime = await launcher.start();
    browser = new BrowserConnection(runtime.kind, runtime.endpoint, { launcher, runtime });
    await browser.initialize();
    return browser;
  } catch (error) {
    if (browser) await browser.close();
    else await launcher.close();
    throw error;
  }
}

/** Chromium publishes /json/version with a browser WebSocket URL; anything else is Firefox WebDriver BiDi. */
export async function connectBrowser(options: BrowserConnectOptions): Promise<BrowserSession> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  if (!(await lstat(options.socketPath)).isSocket()) throw new Error("Remote browser must be a Unix socket, not a file or symlink");
  const discovery = await new Promise<unknown>((resolve, reject) => {
    const discovery = request({ socketPath: options.socketPath, path: "/json/version",
      headers: { Host: "127.0.0.1:9222" }, signal }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(undefined);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(undefined); }
      });
    });
    discovery.on("error", reject);
    discovery.end();
  });
  const socketUrl = discovery && typeof discovery === "object" ? cdpObject(discovery).webSocketDebuggerUrl : undefined;
  let endpoint = "ws://127.0.0.1:9222/session";
  if (typeof socketUrl === "string") {
    const discovered = new URL(socketUrl);
    if (discovered.protocol !== "ws:" || !discovered.pathname.startsWith("/devtools/browser/")) throw new Error("Chromium returned an invalid browser WebSocket URL");
    // Only discovery's path is used; both requests dial the same Unix socket.
    endpoint = `ws://127.0.0.1:9222${discovered.pathname}${discovered.search}`;
  }
  const browser = new BrowserConnection(typeof socketUrl === "string" ? "chromium" : "firefox", endpoint);
  try {
    await browser.initialize(signal, options.socketPath);
    return browser;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}
