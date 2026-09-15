// Shared Firefox BiDi transport over one long-lived Node WebSocket connection.
export type BidiObject = Record<string, unknown>;
export type BidiListener = (method: string, params: BidiObject) => void;

export function object(value: unknown): BidiObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as BidiObject : {};
}

/** Decode protocol data without prototype setters; keep non-JSON and truncated values explicit. */
export function remoteValue(value: unknown): unknown {
  const remote = object(value);
  switch (remote.type) {
    case "null": return null;
    case "undefined": return { type: "undefined" };
    case "string": case "boolean": return remote.value;
    case "number": return typeof remote.value === "number" ? remote.value : { type: "number", value: remote.value };
    case "bigint": return { type: "bigint", value: remote.value };
    case "array":
      return Array.isArray(remote.value) ? remote.value.map(remoteValue) : { type: "array", truncated: true };
    case "object":
      return Array.isArray(remote.value) ? Object.fromEntries(remote.value.map(entry => {
        const pair = Array.isArray(entry) ? entry : [];
        return [typeof pair[0] === "string" ? pair[0] : String(remoteValue(pair[0])), remoteValue(pair[1])];
      })) : { type: "object", truncated: true };
    default: return { type: remote.type ?? "unknown", ...(remote.value === undefined ? {} : { value: remote.value }) };
  }
}

interface Pending {
  resolve: (value: BidiObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BidiCommandError extends Error {}

export class Bidi {
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<BidiListener>();
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
          if (message.type === "error") pending.reject(new BidiCommandError(`BiDi ${String(message.error)}: ${String(message.message)}`));
          else pending.resolve(object(message.result));
        } else if (message.type === "event" && typeof message.method === "string") {
          for (const listener of this.listeners) listener(message.method, object(message.params));
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("close", () => this.fail(new Error("Firefox debugging connection closed")));
    socket.addEventListener("error", () => this.fail(new Error("Firefox debugging connection failed")));
  }

  static async connect(url: string, timeoutMs = 5_000): Promise<Bidi> {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)) {
      throw new Error("Firefox debugging endpoint must be loopback-only");
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to Firefox debugging socket"));
      }, timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error("Could not connect to Firefox debugging socket"));
      }, { once: true });
    });
    return new Bidi(socket);
  }

  onEvent(listener: BidiListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method: string, params: BidiObject = {}, timeoutMs = 15_000): Promise<BidiObject> {
    if (this.closed) return Promise.reject(new Error("Firefox debugging connection is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BiDi ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
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
    this.fail(new Error("Firefox debugging connection closed"));
    this.listeners.clear();
    this.socket.close();
  }
}
