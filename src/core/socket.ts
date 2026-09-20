import { createConnection } from "node:net";
import WebSocket from "ws";

/** Owned launches use TCP; published browsers keep the logical URL but dial Unix. */
export async function connectSocket(url: string, label: string, timeoutMs: number, signal?: AbortSignal, socketPath?: string): Promise<WebSocket> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.hash || endpoint.port === "0") {
    throw new Error("Browser debugging endpoint must be a loopback WebSocket URL without credentials or a fragment");
  }
  signal?.throwIfAborted();
  // Keep the URL's logical Host header while dialing the publisher's Unix socket.
  const options = { closeTimeout: 1_000, perMessageDeflate: false,
    ...(socketPath ? { createConnection: () => createConnection({ path: socketPath }) } : {}) };
  const socket = new WebSocket(url, options);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeEventListener("open", open);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", closed);
      if (error !== undefined) {
        // terminate() during a handshake emits a later error, after rejection.
        socket.on("error", () => {});
        socket.terminate();
        reject(error);
      } else resolve();
    };
    const open = () => finish();
    const failed = (event: WebSocket.ErrorEvent) => finish(new Error(`Could not connect to ${label} debugging socket: ${event.message}`));
    const closed = () => finish(new Error(`${label} debugging socket closed during connection`));
    const abort = () => finish(signal?.reason ?? new Error("Browser connection cancelled"));
    const timer = setTimeout(() => finish(new Error(`Timed out connecting to ${label} debugging socket`)), timeoutMs);
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", closed, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
  });
  return socket;
}
