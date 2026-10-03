import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { connectBrowser, launchBrowser } from "../core/session.ts";
import { publicBrowserError } from "../core/process.ts";
import type { BrowserSession } from "../core/types.ts";
import { abortable } from "../web/async.ts";
import { processAlive, receive, send, START_TIMEOUT_MS, type BrokerMessage, type BrokerPaths, type BrowserSource, type OpenResult, type Request, type TabInfo } from "./protocol.ts";

/** Recently used tabs per session; their union keeps broker-opened tabs alive. */
const RECENT_TABS = 10;
const TAB_NAME = /^[^\s\u0000-\u001f\u007f]{1,200}$/;

/** Host (with port) without a leading www., plus the length of everything after it. */
export function tabName(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { return "tab"; }
  const base = url.host ? url.host.replace(/^www\./, "") : url.protocol.slice(0, -1);
  const rest = url.host ? url.href.slice(url.href.indexOf(url.host) + url.host.length).replace(/^\//, "") : url.href.slice(url.protocol.length);
  return rest ? `${base}+${rest.length}` : base;
}

interface Entry {
  id: string;
  name: string;
  openedBy: "broker" | "other";
  /** Sync generation at registration; an older page snapshot cannot remove it. */
  generation: number;
  users: Set<string>;
  last?: { session: string; at: number };
  /** Settles when the latest holder or waiter of this tab releases it; calls queue behind it. */
  lock: Promise<void>;
}

interface Client {
  socket: Socket;
  session?: string;
  recent: { id: string; name: string }[];
  running: Map<number, AbortController>;
  /** Tabs this connection's calls hold exclusively, by lease number. */
  leases: Map<number, { entry: Entry; release: () => void }>;
}

class BrokerError extends Error {
  readonly code: "browser-unavailable" | "tab-closed";
  constructor(message: string, code: "browser-unavailable" | "tab-closed") {
    super(message);
    this.code = code;
  }
}

export interface BrokerOptions { paths: BrokerPaths; source: BrowserSource; idleMs: number }

/** The only holder of one browser connection; any number of Pi sessions share its named tabs. */
export class Broker {
  private readonly options: BrokerOptions;
  private readonly server: Server;
  private readonly clients = new Set<Client>();
  private readonly entries = new Map<string, Entry>();
  private browser?: Promise<BrowserSession>;
  private generation = 0;
  private nextLease = 1;
  private idle?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<void>;

  constructor(options: BrokerOptions) {
    this.options = options;
    this.server = createServer(socket => this.accept(socket));
  }

  async start(): Promise<void> {
    const { socket, record } = this.options.paths;
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server.once("error", reject);
          this.server.listen(socket, () => { this.server.off("error", reject); resolve(); });
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt > 0) throw error;
        if (await accepting(socket)) process.exit(0);
        const owner = await readJson(record);
        if (processAlive(owner?.pid)) throw new Error(`Browser broker ${String(owner?.pid)} is alive but not accepting connections on ${socket}.`);
        await rm(socket, { force: true });
      }
    }
    await writeFile(record, JSON.stringify({ pid: process.pid }) + "\n", { mode: 0o600 });
    // The starting client may take up to its start timeout to connect, even with no idle grace.
    this.scheduleExit(Math.max(this.options.idleMs, START_TIMEOUT_MS));
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => { void this.stop(); });
  }

  private scheduleExit(milliseconds = this.options.idleMs): void {
    clearTimeout(this.idle);
    if (!this.clients.size) this.idle = setTimeout(() => { void this.stop(); }, milliseconds);
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      clearTimeout(this.idle);
      this.server.close();
      for (const client of this.clients) client.socket.destroy();
      await Promise.allSettled([unlink(this.options.paths.socket), unlink(this.options.paths.record)]);
      // A launched browser closes normally (flushing cookies); a remote keeps running with only our tabs closed.
      await (await this.browser?.catch(() => undefined))?.close().catch(() => {});
      process.exit(0);
    })();
    return this.stopping;
  }

  private accept(socket: Socket): void {
    const client: Client = { socket, recent: [], running: new Map(), leases: new Map() };
    this.clients.add(client);
    this.scheduleExit();
    socket.on("error", () => {});
    socket.on("close", () => {
      this.clients.delete(client);
      for (const controller of client.running.values()) controller.abort(new Error("Client disconnected"));
      for (const lease of client.leases.values()) lease.release();
      client.leases.clear();
      void this.check().catch(() => {});
      this.scheduleExit();
    });
    receive(socket, message => {
      if (!message || typeof message !== "object") return;
      if ("cancel" in message) { client.running.get(Number(message.cancel))?.abort(new Error("Browser operation cancelled")); return; }
      const request = message as Request;
      if (typeof request.id !== "number" || typeof request.method !== "string") return;
      const controller = new AbortController();
      client.running.set(request.id, controller);
      void this.handle(client, request, controller.signal).then(
        result => send(socket, { id: request.id, result }),
        (error: unknown) => send(socket, { id: request.id, error: { message: publicBrowserError(error),
          ...(error instanceof BrokerError ? { code: error.code } : {}) } }),
      ).finally(() => client.running.delete(request.id));
    });
  }

  private broadcast(message: BrokerMessage): void {
    for (const client of this.clients) send(client.socket, message);
  }

  private async handle(client: Client, request: Request, signal: AbortSignal): Promise<unknown> {
    if (request.method === "hello") {
      const launched = "browser" in this.options.source ? this.options.source.headless ?? false : false;
      if ("browser" in this.options.source && request.params.headless !== launched) {
        throw new Error(`This browser was started ${launched ? "headless" : "headed"} by another session; close that session or use the same headless setting.`);
      }
      if (typeof request.params.session !== "string" || !request.params.session) throw new Error("A session ID is required.");
      client.session = request.params.session;
      return null;
    }
    if (!client.session) throw new Error("Say hello first.");
    if (request.method === "release") {
      client.leases.get(request.params.lease)?.release();
      client.leases.delete(request.params.lease);
      return null;
    }
    // Connect before syncing so a fresh broker already knows existing pages, such as a remote's human tabs.
    if (request.method === "open" || request.method === "list") await this.connection();
    await this.check();
    if (request.method === "open") return this.open(client, request.params, signal);
    if (request.method === "list") return this.list(client);
    const lease = client.leases.get(request.params.lease);
    if (!lease) throw new Error("This call no longer holds the tab.");
    const entry = lease.entry;
    if (this.entries.get(entry.id) !== entry) throw new BrokerError("The tab was closed.", "tab-closed");
    const tab = await (await this.connection()).tab(entry.id);
    try {
      if (request.method === "navigate") return await tab.navigate(request.params.url, { signal, timeoutMs: request.params.timeoutMs });
      if (request.method === "evaluate") return await tab.evaluate(request.params.expression, { signal, timeoutMs: request.params.timeoutMs });
      if (request.method === "screenshot") return await tab.screenshot();
      if (request.method === "focus") return await tab.focus();
      throw new Error("Unknown broker method.");
    } finally {
      if (tab.closed) this.remove(entry);
    }
  }

  private connection(): Promise<BrowserSession> {
    this.browser ??= (async () => {
      const source = this.options.source;
      try {
        if ("remote" in source) return await connectBrowser({ socketPath: source.socketPath });
        await releaseStaleProfile(source.profileDir);
        return await launchBrowser({ browser: source.browser, profileDir: source.profileDir, headless: source.headless });
      } catch (error) {
        this.browser = undefined;
        if (!("remote" in source)) throw new BrokerError(publicBrowserError(error), "browser-unavailable");
        // Transport diagnostics can include the Unix path; receipts use the remote name only.
        throw new BrokerError(`Could not connect to remote ${source.remote}: ${publicBrowserError(error).replaceAll(source.socketPath, `remote ${source.remote}`)}`, "browser-unavailable");
      }
    })();
    return this.browser;
  }

  /** Sync names with the browser's pages, then close broker-opened tabs no session still uses. */
  private async check(): Promise<void> {
    const browser = await this.browser?.catch(() => undefined);
    if (!browser) return;
    if (browser.closed) {
      this.browser = undefined;
      this.entries.clear();
      await browser.close().catch(() => {});
      this.broadcast({ event: "browser-closed", reason: "The browser closed or disconnected; all its tabs are gone. The next call opens it again." });
      return;
    }
    const generation = ++this.generation;
    let pages: { id: string; url: string }[];
    try { pages = await browser.pages(); }
    catch { return; }
    const present = new Set(pages.map(page => page.id));
    for (const entry of this.entries.values()) {
      if (!present.has(entry.id) && entry.generation < generation) this.remove(entry);
    }
    for (const page of pages) {
      if (!this.entries.has(page.id)) this.register(page.id, this.unique(tabName(page.url)), "other");
    }
    const recent = new Set([...this.clients].flatMap(client => client.recent.map(item => item.id)));
    for (const entry of [...this.entries.values()]) {
      if (entry.openedBy !== "broker" || recent.has(entry.id)) continue;
      this.remove(entry);
      await browser.tab(entry.id).then(tab => tab.close()).catch(() => {});
    }
  }

  private register(id: string, name: string, openedBy: Entry["openedBy"]): Entry {
    const entry: Entry = { id, name, openedBy, generation: this.generation + 1, users: new Set(), lock: Promise.resolve() };
    this.entries.set(id, entry);
    return entry;
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id);
    this.broadcast({ event: "tab-closed", id: entry.id });
  }

  private unique(name: string): string {
    const taken = new Set([...this.entries.values()].map(entry => entry.name));
    if (!taken.has(name)) return name;
    let index = 2;
    while (taken.has(`${name}-${index}`)) index++;
    return `${name}-${index}`;
  }

  /** Keeps the tab in this session's recent list, which also makes it the session's default. */
  private remember(client: Client, entry: Entry): void {
    client.recent = [{ id: entry.id, name: entry.name }, ...client.recent.filter(item => item.id !== entry.id)].slice(0, RECENT_TABS);
  }

  /** Whole-call exclusive use of a tab: waits for earlier holders in order. A cancelled waiter never releases them. */
  private async acquire(client: Client, entry: Entry, signal: AbortSignal): Promise<number> {
    const previous = entry.lock;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    entry.lock = previous.then(() => held);
    try { await abortable(previous, signal); }
    catch (error) { release(); throw error; }
    if (this.entries.get(entry.id) !== entry) { release(); throw new BrokerError("The tab was closed.", "tab-closed"); }
    const lease = this.nextLease++;
    client.leases.set(lease, { entry, release });
    return lease;
  }

  private async open(client: Client, params: { tab?: string; id?: string; url?: string; create?: boolean }, signal: AbortSignal): Promise<OpenResult> {
    const warnings: string[] = [];
    let entry: Entry | undefined;
    let name: string | undefined;
    if (params.id !== undefined) {
      entry = this.entries.get(params.id);
      if (!entry) throw new BrokerError("The tab was closed.", "tab-closed");
    } else if (params.create) name = tabName(params.url ?? "about:blank");
    else if (params.tab !== undefined) {
      entry = [...this.entries.values()].find(candidate => candidate.name === params.tab);
      if (!entry) {
        if (!params.url) throw new Error(`Unknown tab "${params.tab}". List tabs, or give a url to open a new tab with this name.`);
        if (!TAB_NAME.test(params.tab)) throw new Error("Tab names are 1–200 characters without whitespace or control characters.");
        name = params.tab;
      }
    } else {
      const last = client.recent[0];
      entry = last && this.entries.get(last.id);
      if (!entry) {
        if (!params.url) throw new Error(last ? `Your last tab "${last.name}" was closed. Give a url to open a new tab.` : "This session has no tab yet. Give a url to open one.");
        if (last) warnings.push(`Your last tab "${last.name}" was closed; opened a new tab.`);
        name = tabName(params.url);
      }
    }
    const browser = await this.connection();
    const created = !entry;
    if (!entry) {
      const tab = await browser.openTab();
      // Register and remember before any await so a concurrent check neither renames nor collects it.
      entry = this.register(tab.id, this.unique(name!), "broker");
    }
    this.remember(client, entry);
    const lease = await this.acquire(client, entry, signal);
    if (entry.last && entry.last.session !== client.session && entry.users.has(client.session!)) {
      warnings.push(`Tab "${entry.name}" was used by session ${entry.last.session} at ${new Date(entry.last.at).toISOString()} since this session last used it.`);
    }
    entry.users.add(client.session!);
    entry.last = { session: client.session!, at: Date.now() };
    return { id: entry.id, lease, name: entry.name, browser: browser.browser, created, warnings };
  }

  private async list(client: Client): Promise<TabInfo[]> {
    const browser = await this.connection();
    const pages = new Map((await browser.pages()).map(page => [page.id, page]));
    return Promise.all([...this.entries.values()].filter(entry => pages.has(entry.id)).map(async entry => {
      const page = pages.get(entry.id)!;
      let title = page.title;
      if (title === undefined) {
        title = await browser.tab(entry.id).then(tab => tab.evaluate("document.title", { timeoutMs: 1_000 })).then(String, () => "");
      }
      const self = entry.last?.session === client.session;
      return { name: entry.name, url: page.url, title, openedBy: entry.openedBy, current: client.recent[0]?.id === entry.id,
        ...(entry.last ? { lastSession: self ? "this session" : entry.last.session, lastUsedAt: new Date(entry.last.at).toISOString() } : {}) };
    }));
  }
}

function accepting(socket: string): Promise<boolean> {
  return new Promise(resolve => {
    const connection = createConnection(socket);
    connection.once("connect", () => { connection.destroy(); resolve(true); });
    connection.once("error", () => resolve(false));
  });
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; }
  catch { return undefined; }
}

/** Take over a profile lock only when its recorded owner and browser are confirmed gone. */
async function releaseStaleProfile(profileDir: string): Promise<void> {
  const lock = path.join(profileDir, ".pi-browser-owner");
  const owner = await readJson(path.join(lock, "owner.json"));
  if (owner && !processAlive(owner.pid) && !processAlive(owner.browserPid)) await rm(lock, { recursive: true, force: true });
}

