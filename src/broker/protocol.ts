import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserKind } from "../core/types.ts";

/** A browser the broker launches with a stable profile, or a published remote socket it attaches to. */
export type BrowserSource =
  | { browser: BrowserKind; profileDir: string; headless?: boolean }
  | { remote: string; socketPath: string };

export interface TabInfo {
  name: string;
  url: string;
  title: string;
  /** Session that last used the tab through the broker. */
  lastSession?: string;
  lastUsedAt?: string;
  /** Opened by the broker (closed when no session's recent list holds it) or by a person/page (never auto-closed). */
  openedBy: "broker" | "other";
  /** This session's default tab: its most recently used. */
  current: boolean;
}

/** The opened tab, held exclusively by this call until released. */
export interface OpenResult {
  id: string;
  lease: number;
  name: string;
  browser: BrowserKind;
  created: boolean;
  warnings: string[];
}

export type Request =
  | { id: number; method: "hello"; params: { session: string; headless: boolean } }
  | { id: number; method: "open"; params: { tab?: string; id?: string; url?: string; create?: boolean } }
  | { id: number; method: "release"; params: { lease: number } }
  | { id: number; method: "list"; params: Record<string, never> }
  | { id: number; method: "navigate"; params: { lease: number; url: string; timeoutMs?: number } }
  | { id: number; method: "evaluate"; params: { lease: number; expression: string; timeoutMs?: number } }
  | { id: number; method: "screenshot"; params: { lease: number } }
  | { id: number; method: "focus"; params: { lease: number } };

export type ClientMessage = Request | { cancel: number };

export type BrokerMessage =
  | { id: number; result?: unknown }
  | { id: number; error: { message: string; code?: "browser-unavailable" | "tab-closed" } }
  | { event: "tab-closed"; id: string }
  | { event: "browser-closed"; reason: string };

/** How long a client waits for a broker it started to accept connections. */
export const START_TIMEOUT_MS = 15_000;

export function send(socket: Socket, message: ClientMessage | BrokerMessage): void {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(message) + "\n");
}

/** Newline-delimited JSON. A malformed peer is disconnected. */
export function receive(socket: Socket, handle: (message: unknown) => void): void {
  let parts: string[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end >= 0; end = chunk.indexOf("\n", start)) {
      parts.push(chunk.slice(start, end));
      const line = parts.join("");
      parts = [];
      start = end + 1;
      if (!line) continue;
      try { handle(JSON.parse(line)); }
      catch { socket.destroy(); return; }
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  });
}

/** Private per-user socket directory, like tmux: short paths and one broker per browser source on this host. */
async function brokerDirectory(): Promise<string> {
  const uid = process.getuid?.() ?? 0;
  const directory = path.join(tmpdir(), `pi-browser-${uid}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error(`Browser broker directory ${directory} must be a private directory owned by this user (mode 0700), not a symlink.`);
  }
  return directory;
}

export interface BrokerPaths { socket: string; record: string; log: string }

/** Profiles are identified by real path so every host reaches the same broker. */
export async function brokerPaths(source: BrowserSource): Promise<BrokerPaths> {
  let key: string;
  if ("remote" in source) key = `remote:${path.resolve(source.socketPath)}`;
  else {
    await mkdir(source.profileDir, { recursive: true, mode: 0o700 });
    key = `profile:${await realpath(source.profileDir)}`;
  }
  const base = path.join(await brokerDirectory(), createHash("sha256").update(key).digest("hex").slice(0, 24));
  return { socket: `${base}.sock`, record: `${base}.json`, log: `${base}.log` };
}

export function processAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
