// Shared direct CDP transport. Replies and page events are dispatched concurrently.

export type CdpObject = Record<string, unknown>;
export type CdpListener = (method: string, params: CdpObject) => void;

export function object(value: unknown): CdpObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as CdpObject : {};
}

interface Pending {
  resolve: (value: CdpObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Cdp {
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<CdpListener>();
  private isClosed = false;

  get closed(): boolean { return this.isClosed; }

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      try {
        const message = object(JSON.parse(String(event.data)));
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            const error = object(message.error);
            pending.reject(new Error(`CDP: ${String(error.message ?? JSON.stringify(error))}`));
          } else pending.resolve(object(message.result));
        } else if (typeof message.method === "string") {
          for (const listener of this.listeners) listener(message.method, object(message.params));
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("close", () => this.fail(new Error("Chromium debugging connection closed")));
    socket.addEventListener("error", () => this.fail(new Error("Chromium debugging connection failed")));
  }

  static async connect(url: string): Promise<Cdp> {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)) {
      throw new Error("Chromium debugging endpoint must be loopback-only");
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to Chromium debugging socket"));
      }, 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error(`Could not connect to Chromium debugging socket: ${url}`));
      }, { once: true });
    });
    return new Cdp(socket);
  }

  onEvent(listener: CdpListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method: string, params: CdpObject = {}, timeoutMs = 15_000): Promise<CdpObject> {
    if (this.closed) return Promise.reject(new Error("Chromium debugging connection is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error): void {
    this.isClosed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(): void {
    this.fail(new Error("Chromium debugging connection closed"));
    this.listeners.clear();
    this.socket.close();
  }
}
