import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type SnapshotFormat = "md" | "text" | "html" | "json" | "screenshot" | "before-screenshot";
/** Page evidence only. Producers must exclude host credentials and host-generated artifact paths. */
export interface SnapshotInput {
  kind: "search" | "fetch" | "browser";
  metadata: Record<string, unknown>;
  md?: string;
  text?: string;
  html?: string;
  screenshot?: string;
  beforeScreenshot?: string;
  json?: Record<string, unknown>;
  warnings?: string[];
}
export interface SnapshotInfo {
  id: string;
  kind: SnapshotInput["kind"];
  createdAt: string;
  available: SnapshotFormat[];
  warnings: string[];
  /** Host-only artifact paths. Never include these in model-facing receipts. */
  paths: Partial<Record<SnapshotFormat, string>>;
}
export interface SnapshotRead {
  snapshot: string;
  kind: SnapshotInput["kind"];
  createdAt: string;
  format: SnapshotFormat;
  available: SnapshotFormat[];
  warnings: string[];
  text?: string;
  image?: { data: string; mimeType: "image/png" };
  nextCursor?: string;
}

const FORMATS: SnapshotFormat[] = ["md", "text", "html", "json", "screenshot", "before-screenshot"];
const FILES: Record<SnapshotFormat, string> = {
  md: "content.md", text: "content.txt", html: "content.html", json: "content.json",
  screenshot: "screenshot.png", "before-screenshot": "before-screenshot.png",
};
const ID = /^snap_[a-f0-9]{32}$/;
const MiB = 1024 * 1024;
const CAPTURE_BYTES = 4 * MiB;
// Base64 images can be duplicated in serialized host history; keep each image practical.
const IMAGE_BYTES = MiB;
const operationQueues = new Map<string, Promise<void>>();
const MANIFEST_BYTES = 16 * 1024;
const PAGE_BYTES = 44 * 1024;
const PAGE_LINES = 1900;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface Manifest {
  id: string;
  kind: SnapshotInput["kind"];
  createdAt: string;
  available: SnapshotFormat[];
  warnings: string[];
  sizes: Partial<Record<SnapshotFormat, number>>;
  cursorKey: string;
}

export class SnapshotError extends Error {
  readonly code: "invalid-id" | "expired" | "unavailable" | "invalid-cursor" | "unsafe-store" | "corrupt" | "owned";
  constructor(code: SnapshotError["code"], message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/** Prefix by UTF-8 bytes without splitting a Unicode code point. */
function prefix(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value.slice(0, maxBytes + 1));
  if (buffer.length <= maxBytes) return buffer.toString();
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString();
}

function validateId(id: string): void {
  if (typeof id !== "string" || !ID.test(id)) throw new SnapshotError("invalid-id", "Invalid snapshot ID; use an ID returned by a web or browser tool, not a path.");
}

async function privateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
    throw new SnapshotError("unsafe-store", "Snapshot storage must be an owned, private directory without symlinks.");
  }
}

async function privateRead(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new SnapshotError("unsafe-store", "Snapshot artifact is not a bounded, owned, private file.");
    }
    return await handle.readFile();
  } finally { await handle.close(); }
}

function warningList(input: string[] = []): string[] {
  const result = input.slice(0, 16).map(value => prefix(String(value), 128).replace(/[\u0000-\u001f\u007f]/g, " "));
  if (input.length > 16) result.push("Additional capture warnings omitted.");
  return result;
}

/** Keep arbitrary page data serializable and bounded without filtering field names. */
function structured(value: unknown, maxBytes: number, warnings: string[]): unknown {
  let remaining = maxBytes;
  let nodes = 0;
  let limited = false;
  let omittedKeys = false;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 50_000 || remaining < 16 || depth > 32) { limited = true; return null; }
    remaining -= 8;
    if (typeof item === "string") {
      // Budget the actual JSON encoding instead of truncating ordinary strings
      // to one sixth of the available space for a theoretical worst case.
      let bytes = Math.max(0, remaining - 2);
      let text = prefix(item, bytes);
      let encodedBytes = Buffer.byteLength(JSON.stringify(text));
      while (encodedBytes > remaining && bytes > 0) {
        bytes = Math.max(0, Math.floor(bytes * (remaining - 2) / encodedBytes));
        text = prefix(item, bytes);
        encodedBytes = Buffer.byteLength(JSON.stringify(text));
      }
      remaining -= encodedBytes;
      if (text !== item) limited = true;
      return text;
    }
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      remaining -= JSON.stringify(item).length;
      return item;
    }
    if (typeof item !== "object") { limited = true; return null; }
    if (ancestors.has(item)) { limited = true; return null; }
    ancestors.add(item);
    const result: unknown[] | Record<string, unknown> = Array.isArray(item) ? [] : Object.create(null) as Record<string, unknown>;
    if (Array.isArray(item)) {
      for (const child of item) {
        if (remaining < 32 || nodes >= 50_000) { limited = true; break; }
        (result as unknown[]).push(visit(child, depth + 1));
      }
    } else {
      for (const key of Object.keys(item)) {
        // JSON normally omits absent optional object fields; that is not capture loss.
        if ((item as Record<string, unknown>)[key] === undefined) continue;
        if (remaining < 32 || nodes >= 50_000) { limited = true; break; }
        const keyBytes = Buffer.byteLength(JSON.stringify(key));
        if (keyBytes > remaining - 32) { omittedKeys = true; continue; }
        remaining -= keyBytes;
        (result as Record<string, unknown>)[key] = visit((item as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(item);
    return result;
  }
  const result = visit(value, 0);
  if (omittedKeys) warnings.push("Structured JSON entries with oversized keys omitted at capture limits; keys are never truncated.");
  if (limited) warnings.push("Structured JSON truncated or non-JSON values omitted at capture limits.");
  return result;
}

/** Immutable disk evidence. Operations share an in-process queue and an exclusive disk lock. */
export class SnapshotStore {
  readonly directory: string;
  private readonly maxSnapshots: number;
  private readonly maxBytes: number;

  constructor(options: { directory?: string; maxSnapshots?: number; maxBytes?: number } = {}) {
    this.directory = path.resolve(options.directory ?? path.join(tmpdir(), `pi-web-snapshots-${randomBytes(16).toString("hex")}`));
    this.maxSnapshots = options.maxSnapshots ?? 64;
    this.maxBytes = options.maxBytes ?? 256 * MiB;
    if (!Number.isSafeInteger(this.maxSnapshots) || this.maxSnapshots < 1 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error("Snapshot maxSnapshots and maxBytes must be positive integers.");
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = (operationQueues.get(this.directory) ?? Promise.resolve()).then(async () => {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await privateDirectory(this.directory);
        const lock = path.join(this.directory, ".operation-lock");
        try {
          await mkdir(lock, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new SnapshotError("owned", "Snapshot storage is locked by another operation. Retry after it finishes; interrupted locks require explicit host recovery after confirming the owner stopped.");
          }
          throw error;
        }
        try {
          const owner = await open(path.join(lock, "owner.json"), "wx", 0o600);
          try { await owner.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
          finally { await owner.close(); }
          return await operation();
        } finally {
          await rm(path.join(lock, "owner.json"), { force: true });
          await rmdir(lock);
        }
      } catch (error) {
        if (error instanceof SnapshotError) throw error;
        // Native filesystem errors contain host paths; never forward them to web_read.
        throw new SnapshotError("unavailable", "Snapshot storage is unavailable; its private files may have been removed or become inaccessible.");
      }
    });
    const settled = result.then(() => {}, () => {}).then(() => {
      if (operationQueues.get(this.directory) === settled) operationQueues.delete(this.directory);
    });
    operationQueues.set(this.directory, settled);
    return result;
  }

  save(input: SnapshotInput): Promise<SnapshotInfo> {
    if (this.maxBytes < 1024) return Promise.reject(new SnapshotError("unavailable", "Snapshot metadata exceeds the store byte quota; increase maxBytes."));
    // Capture input before queuing, so callers cannot mutate evidence during an awaited write.
    const id = `snap_${randomBytes(16).toString("hex")}`;
    const createdAt = new Date().toISOString();
    const warnings: string[] = [];
    const captureWarnings = warningList(input.warnings);
    const artifacts = new Map<SnapshotFormat, Buffer>();
    const budget = Math.min(this.maxBytes - Math.min(MANIFEST_BYTES, Math.ceil(this.maxBytes / 4)), 24 * MiB);
    const formatLimit = Math.min(CAPTURE_BYTES, Math.floor(budget / FORMATS.length));
    for (const [format, value] of [["md", input.md], ["text", input.text ?? input.md], ["html", input.html]] as const) {
      if (value === undefined) continue;
      const saved = prefix(value, formatLimit);
      artifacts.set(format, Buffer.from(saved));
      if (saved !== value) warnings.push(`${format} truncated at ${formatLimit} bytes during capture.`);
    }
    if (input.text === undefined && input.md !== undefined) warnings.push("Text uses the captured Markdown fallback; Markdown syntax is retained.");
    for (const [format, value] of [["screenshot", input.screenshot], ["before-screenshot", input.beforeScreenshot]] as const) {
      if (value === undefined) continue;
      const imageLimit = Math.min(formatLimit, IMAGE_BYTES);
      if (value.length > Math.ceil(imageLimit / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        warnings.push(`${format} omitted: invalid base64 PNG or image exceeds ${imageLimit} bytes.`);
        continue;
      }
      const data = Buffer.from(value, "base64");
      const width = data.length >= 24 ? data.readUInt32BE(16) : 0;
      const height = data.length >= 24 ? data.readUInt32BE(20) : 0;
      if (data.length > imageLimit || data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString("ascii", 12, 16) !== "IHDR" || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216) {
        warnings.push(`${format} omitted: invalid PNG or image exceeds byte/dimension limits (${imageLimit} bytes, 8192 per side, 16 megapixels).`);
        continue;
      }
      artifacts.set(format, data);
    }
    const payload = structured({ metadata: input.metadata, data: input.json ?? {} }, Math.max(1024, formatLimit - 8192), warnings);
    warnings.push(...captureWarnings);
    const manifest: Manifest = { id, kind: input.kind, createdAt, available: FORMATS.filter(format => format === "json" || artifacts.has(format)), warnings,
      sizes: {}, cursorKey: randomBytes(32).toString("hex") };
    artifacts.set("json", Buffer.from(JSON.stringify({ snapshot: id, kind: input.kind, createdAt, available: manifest.available, warnings, ...payload as Record<string, unknown> })));
    for (const [format, data] of artifacts) manifest.sizes[format] = data.length;
    const manifestData = Buffer.from(JSON.stringify(manifest));
    const size = manifestData.length + [...artifacts.values()].reduce((sum, data) => sum + data.length, 0);
    if (size > this.maxBytes) return Promise.reject(new SnapshotError("unavailable", "Snapshot metadata exceeds the store byte quota; increase maxBytes."));
    return this.run(async () => {
      const pending = path.join(this.directory, `.pending-${id}`);
      await mkdir(pending, { mode: 0o700 });
      try {
        for (const [format, data] of artifacts) {
          const handle = await open(path.join(pending, FILES[format]), "wx", 0o600);
          try { await handle.writeFile(data); } finally { await handle.close(); }
        }
        const handle = await open(path.join(pending, "manifest.json"), "wx", 0o600);
        try { await handle.writeFile(manifestData); } finally { await handle.close(); }
        const existing: { id: string; writtenAt: number; size: number }[] = [];
        for (const entry of await readdir(this.directory)) {
          if (!ID.test(entry)) continue;
          const prior = await this.manifest(entry);
          const stat = await lstat(path.join(this.directory, entry, "manifest.json"));
          existing.push({ id: entry, writtenAt: stat.mtimeMs, size: stat.size + Object.values(prior.sizes).reduce((sum, bytes) => sum + bytes, 0) });
        }
        existing.sort((a, b) => a.writtenAt - b.writtenAt || a.id.localeCompare(b.id));
        let total = size + existing.reduce((sum, entry) => sum + entry.size, 0);
        while (existing.length >= this.maxSnapshots || total > this.maxBytes) {
          const oldest = existing.shift();
          if (!oldest) throw new SnapshotError("unavailable", "Snapshot exceeds the store byte quota.");
          await rm(path.join(this.directory, oldest.id), { recursive: true });
          total -= oldest.size;
        }
        await rename(pending, path.join(this.directory, id));
        return this.describe(manifest);
      } finally { await rm(pending, { recursive: true, force: true }); }
    });
  }

  private async manifest(id: string): Promise<Manifest> {
    validateId(id);
    const directory = path.join(this.directory, id);
    try {
      await privateDirectory(directory);
      const parsed: Manifest = JSON.parse((await privateRead(path.join(directory, "manifest.json"), MANIFEST_BYTES)).toString());
      if (parsed.id !== id || !["search", "fetch", "browser"].includes(parsed.kind) || typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || !/^[a-f0-9]{64}$/.test(parsed.cursorKey) ||
        !Array.isArray(parsed.available) || !parsed.available.includes("json") || new Set(parsed.available).size !== parsed.available.length || parsed.available.some(format => !FORMATS.includes(format)) ||
        !Array.isArray(parsed.warnings) || parsed.warnings.length > 32 || parsed.warnings.some(warning => typeof warning !== "string" || Buffer.byteLength(warning) > 1024) ||
        !parsed.sizes || Object.keys(parsed.sizes).length !== parsed.available.length || parsed.available.some(format => !Number.isSafeInteger(parsed.sizes[format]) || parsed.sizes[format]! < 0 || parsed.sizes[format]! > CAPTURE_BYTES + MANIFEST_BYTES)) {
        throw new SnapshotError("corrupt", `Snapshot ${id} has an invalid manifest.`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof SnapshotError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SnapshotError("expired", `Snapshot ${id} expired or is not present in this store. Capture it again to obtain a new ID.`);
      throw new SnapshotError("corrupt", `Snapshot ${id} is unavailable or damaged.`);
    }
  }

  private describe(manifest: Manifest): SnapshotInfo {
    return { id: manifest.id, kind: manifest.kind, createdAt: manifest.createdAt, available: [...manifest.available], warnings: [...manifest.warnings],
      paths: Object.fromEntries(manifest.available.map(format => [format, path.join(this.directory, manifest.id, FILES[format])])) };
  }

  info(id: string): Promise<SnapshotInfo> {
    validateId(id);
    return this.run(async () => this.describe(await this.manifest(id)));
  }

  read(id: string, format: SnapshotFormat = "md", cursor?: string): Promise<SnapshotRead> {
    validateId(id);
    if (!FORMATS.includes(format)) throw new SnapshotError("unavailable", "Unknown snapshot format. Choose md, text, html, json, screenshot, or before-screenshot.");
    return this.run(async () => {
      const manifest = await this.manifest(id);
      if (!manifest.available.includes(format)) throw new SnapshotError("unavailable", `Snapshot ${id}: ${format} unavailable. Available: ${manifest.available.join(", ")}. ${manifest.warnings.join(" ")}`);
      const result: SnapshotRead = { snapshot: id, kind: manifest.kind, createdAt: manifest.createdAt, format, available: manifest.available, warnings: manifest.warnings };
      const image = format === "screenshot" || format === "before-screenshot";
      let offset = 0;
      if (cursor !== undefined) {
        const match = typeof cursor === "string" && cursor.length < 128 ? /^(\d+)\.([a-f0-9]{64})$/.exec(cursor) : null;
        const expected = match ? createHmac("sha256", manifest.cursorKey).update(`${id}:${format}:${match[1]}`).digest("hex") : "";
        if (image || !match || !timingSafeEqual(Buffer.from(match[2]!), Buffer.from(expected)) || !Number.isSafeInteger(Number(match[1]))) {
          throw new SnapshotError("invalid-cursor", "Invalid cursor: use the continuation returned for this exact snapshot and format.");
        }
        offset = Number(match[1]);
      }
      const data = await privateRead(path.join(this.directory, id, FILES[format]), CAPTURE_BYTES + MANIFEST_BYTES);
      if (data.length !== manifest.sizes[format]) throw new SnapshotError("corrupt", `Snapshot ${id}: saved artifact size changed.`);
      if (image) {
        if (data.length > IMAGE_BYTES) throw new SnapshotError("unavailable", "Saved screenshot exceeds the 1 MiB image read limit; capture a smaller image.");
        result.image = { data: data.toString("base64"), mimeType: "image/png" };
        return result;
      }
      const text = data.toString("utf8");
      if (offset > text.length || (offset > 0 && offset < text.length && /[\uDC00-\uDFFF]/.test(text[offset]!))) throw new SnapshotError("invalid-cursor", "Cursor is outside the saved text.");
      let end = offset;
      let bytes = 0;
      let lines = 1;
      for (const character of text.slice(offset)) {
        const length = format === "json" ? Buffer.byteLength(JSON.stringify(character)) - 2 : Buffer.byteLength(character);
        if (bytes + length > PAGE_BYTES || (character === "\n" && lines >= PAGE_LINES)) break;
        bytes += length;
        if (character === "\n") lines++;
        end += character.length;
      }
      if (end < text.length) result.nextCursor = `${end}.${createHmac("sha256", manifest.cursorKey).update(`${id}:${format}:${end}`).digest("hex")}`;
      const chunk = text.slice(offset, end);
      result.text = format === "json" ? JSON.stringify({ snapshot: id, format, encoding: "json-text", offset, chunk, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }) : chunk;
      return result;
    });
  }
}

export function snapshotSummary(info: SnapshotInfo): string {
  return `Snapshot: ${info.id}\nAvailable: ${info.available.join(", ")}${info.warnings.length ? `\nWarnings: ${warningList(info.warnings).join(" ")}` : ""}`;
}
