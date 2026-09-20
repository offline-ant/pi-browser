import type WebSocket from "ws";
import { connectSocket } from "./socket.ts";

export type CdpObject = Record<string, unknown>;
export type CdpListener = (method: string, params: CdpObject) => void;

export function object(value: unknown): CdpObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as CdpObject : {};
}

interface Pending {
  resolve: (value: CdpObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
}

/** A flattened target session shares the browser socket; closing it never closes the browser. */
export class CdpSession {
  private connection: Cdp;
  private id: string;
  private listeners = new Set<CdpListener>();
  private isClosed = false;

  constructor(connection: Cdp, id: string) { this.connection = connection; this.id = id; }
  get closed(): boolean { return this.isClosed || this.connection.closed; }

  onEvent(listener: CdpListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(method: string, params: CdpObject): void {
    if (!this.closed) for (const listener of this.listeners) listener(method, params);
  }

  request(method: string, params: CdpObject = {}, timeoutMs = 15_000): Promise<CdpObject> {
    if (this.closed) return Promise.reject(new Error("Chromium target session is closed"));
    return this.connection.request(method, params, timeoutMs, this.id);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.listeners.clear();
    this.connection.releaseSession(this.id);
  }
}

/** Replies and target events are dispatched concurrently over one browser WebSocket. */
export class Cdp {
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<CdpListener>();
  private sessions = new Map<string, CdpSession>();
  private isClosed = false;

  get closed(): boolean { return this.isClosed; }

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      try {
        const message = object(JSON.parse(String(event.data)));
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending || pending.sessionId !== message.sessionId) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            const error = object(message.error);
            pending.reject(new Error(`CDP: ${String(error.message ?? JSON.stringify(error))}`));
          } else pending.resolve(object(message.result));
        } else if (typeof message.method === "string") {
          const params = object(message.params);
          if (typeof message.sessionId === "string") this.sessions.get(message.sessionId)?.dispatch(message.method, params);
          else {
            if (message.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") this.sessions.get(params.sessionId)?.close();
            for (const listener of this.listeners) listener(message.method, params);
          }
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("close", () => this.fail(new Error("Chromium debugging connection closed")));
    socket.addEventListener("error", () => this.fail(new Error("Chromium debugging connection failed")));
  }

  static async connect(url: string, signal?: AbortSignal, socketPath?: string): Promise<Cdp> {
    return new Cdp(await connectSocket(url, "Chromium", 10_000, signal, socketPath));
  }

  session(id: string): CdpSession {
    if (this.closed) throw new Error("Chromium debugging connection is closed");
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const session = new CdpSession(this, id);
    this.sessions.set(id, session);
    return session;
  }

  releaseSession(id: string): void {
    this.sessions.delete(id);
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== id) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error("Chromium target session closed"));
    }
  }

  onEvent(listener: CdpListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method: string, params: CdpObject = {}, timeoutMs = 15_000, sessionId?: string): Promise<CdpObject> {
    if (this.closed) return Promise.reject(new Error("Chromium debugging connection is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  close(): void {
    this.fail(new Error("Chromium debugging connection closed"));
    this.listeners.clear();
    this.socket.close();
  }
}
