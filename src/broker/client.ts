import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { BrowserKind, OperationOptions } from "../core/types.ts";
import { brokerPaths, receive, send, START_TIMEOUT_MS, type BrokerMessage, type BrowserSource, type OpenResult, type Request, type TabInfo } from "./protocol.ts";

export class BrowserUnavailable extends Error {}

export interface BrowserClientOptions {
  source: BrowserSource;
  /** Identifies this session to other sessions sharing the browser. */
  session: string;
  /** How long the broker keeps the browser after its last session disconnects. */
  idleMs?: number;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Params<M extends Request["method"]> = Extract<Request, { method: M }>["params"];

/** The tab was closed by a person, another session, or the browser. */
export class TabClosed extends Error {}

/**
 * A named browser tab held exclusively by one call, from open() until release().
 * Other calls on the same tab, from any session, wait until it is released.
 */
export class SharedTab {
  readonly id: string;
  readonly name: string;
  private readonly client: BrowserClient;
  private readonly lease: number;
  closed = false;

  constructor(client: BrowserClient, id: string, name: string, lease: number) {
    this.client = client;
    this.id = id;
    this.name = name;
    this.lease = lease;
  }

  navigate(url: string, options: OperationOptions = {}): Promise<void> {
    return this.client.request("navigate", { lease: this.lease, url, timeoutMs: options.timeoutMs }, options.signal) as Promise<void>;
  }

  evaluate(expression: string, options: OperationOptions = {}): Promise<unknown> {
    return this.client.request("evaluate", { lease: this.lease, expression, timeoutMs: options.timeoutMs }, options.signal);
  }

  async screenshot(): Promise<string> {
    const data = await this.client.request("screenshot", { lease: this.lease });
    if (typeof data !== "string") throw new Error("Browser did not return a screenshot");
    return data;
  }

  focus(): Promise<void> { return this.client.request("focus", { lease: this.lease }) as Promise<void>; }

  /** End this call's use of the tab. A lost broker connection has already released it. */
  release(): Promise<void> { return this.client.release(this, this.lease); }
}

/** One session's connection to the broker of one browser source, started on first use. */
export class BrowserClient {
  readonly source: BrowserSource;
  private readonly options: BrowserClientOptions;
  private socket?: Promise<Socket>;
  private live?: Socket;
  private pending = new Map<number, Pending>();
  /** Tabs held by this session's calls, by lease. */
  private held = new Map<number, SharedTab>();
  private nextId = 1;
  private closed = false;

  constructor(options: BrowserClientOptions) {
    this.options = options;
    this.source = options.source;
  }

  get headless(): boolean { return "browser" in this.source && this.source.headless === true; }

  /** Resolve and hold a tab for one call; waits while another call holds it. Release it when the call ends. */
  async open(params: Params<"open">, signal?: AbortSignal): Promise<{ tab: SharedTab; browser: BrowserKind; created: boolean; warnings: string[] }> {
    const result = await this.request("open", params, signal) as OpenResult;
    const tab = new SharedTab(this, result.id, result.name, result.lease);
    this.held.set(result.lease, tab);
    if (signal?.aborted) {
      await tab.release();
      throw signal.reason;
    }
    return { tab, browser: result.browser, created: result.created, warnings: result.warnings };
  }

  async release(tab: SharedTab, lease: number): Promise<void> {
    if (this.held.get(lease) !== tab) return;
    this.held.delete(lease);
    if (this.live && !this.live.destroyed) await this.request("release", { lease }).catch(() => {});
  }

  list(signal?: AbortSignal): Promise<TabInfo[]> {
    return this.request("list", {}, signal) as Promise<TabInfo[]>;
  }

  async request<M extends Request["method"]>(method: M, params: Params<M>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const socket = await this.connect(signal);
    signal?.throwIfAborted();
    const id = this.nextId++;
    const cancel = () => send(socket, { cancel: id });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      // The broker turns cancellation into the operation's own interruption; await its outcome.
      return await new Promise((resolve, reject) => {
        if (socket.destroyed) { reject(new Error("The browser broker disconnected. Retry to reconnect.")); return; }
        this.pending.set(id, { resolve, reject });
        send(socket, { id, method, params } as Request);
      });
    } finally { signal?.removeEventListener("abort", cancel); }
  }

  private connect(signal?: AbortSignal): Promise<Socket> {
    if (this.closed) return Promise.reject(new Error("Browser client closed."));
    this.socket ??= this.start(signal).catch(error => { this.socket = undefined; throw error; });
    return this.socket;
  }

  private async start(signal?: AbortSignal): Promise<Socket> {
    const paths = await brokerPaths(this.source);
    let socket = await dial(paths.socket);
    if (!socket) {
      const log = openSync(paths.log, "w", 0o600);
      const main = fileURLToPath(new URL(`./main${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
      const child = spawn(process.execPath, [main, JSON.stringify({ paths, source: this.source, idleMs: this.options.idleMs ?? 60_000 })],
        { detached: true, stdio: ["ignore", log, log] });
      closeSync(log);
      child.unref();
      for (const started = Date.now(); !socket; ) {
        signal?.throwIfAborted();
        if (child.exitCode !== null && child.exitCode !== 0 || Date.now() - started > START_TIMEOUT_MS) {
          const diagnostics = (await readFile(paths.log, "utf8").catch(() => "")).trim().slice(-2000);
          throw new BrowserUnavailable(`Browser broker did not start${diagnostics ? `: ${diagnostics}` : "."}`);
        }
        await delay(25);
        socket = await dial(paths.socket);
      }
    }
    const connected = socket;
    receive(connected, message => this.receive(message as BrokerMessage));
    connected.on("error", () => {});
    connected.on("close", () => this.disconnected(connected));
    const id = this.nextId++;
    const hello = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    send(connected, { id, method: "hello", params: { session: this.options.session, headless: this.headless } });
    try { await hello; }
    catch (error) { connected.destroy(); throw error; }
    this.live = connected;
    return connected;
  }

  private receive(message: BrokerMessage): void {
    if ("event" in message) {
      // Held tabs stay registered until their call releases them, so the broker forgets the lease too.
      for (const tab of this.held.values()) if (message.event === "browser-closed" || tab.id === message.id) tab.closed = true;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if ("error" in message) {
      const error = message.error.code === "browser-unavailable" ? new BrowserUnavailable(message.error.message)
        : message.error.code === "tab-closed" ? new TabClosed(message.error.message) : new Error(message.error.message);
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  private disconnected(socket: Socket): void {
    if (this.live === socket) { this.live = undefined; this.socket = undefined; }
    // The broker released this connection's leases.
    for (const tab of this.held.values()) tab.closed = true;
    this.held.clear();
    const error = new Error("The browser broker disconnected; its browser and tabs may be gone. Retry to reconnect.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** Disconnect; the broker closes this session's unused tabs and exits after its idle period. */
  async close(): Promise<void> {
    this.closed = true;
    await this.socket?.catch(() => undefined);
    const socket = this.live;
    if (!socket || socket.destroyed) return;
    await new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.end(); });
  }
}

function dial(socket: string): Promise<Socket | undefined> {
  return new Promise(resolve => {
    const connection = createConnection(socket);
    connection.once("connect", () => { connection.removeAllListeners("error"); resolve(connection); });
    connection.once("error", () => resolve(undefined));
  });
}
