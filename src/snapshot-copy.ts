import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_ID = /^snap_[a-f0-9]{32}$/;
const ARTIFACTS = new Set(["manifest.json", "content.md", "content.txt", "content.html", "content.json", "screenshot.png", "before-screenshot.png"]);
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024 + 16 * 1024;

async function privateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
    throw new Error("Snapshot copy requires owned, private directories without symlinks.");
  }
}

/** Copy one store's immutable evidence, preserving IDs/cursors, into a new store.
 * Missing sources are empty. Existing destinations and active source locks fail.
 * Copies at most 64 snapshots / 256 MiB; never copies profiles, pending writes, or locks.
 */
export async function copySnapshotTree(source: string, destination: string): Promise<void> {
  source = path.resolve(source);
  destination = path.resolve(destination);
  try { await privateDirectory(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lock = path.join(source, ".operation-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Cannot copy an active or interrupted snapshot store; resolve its operation lock first.");
    throw error;
  }
  let created = false;
  try {
    const owner = await open(path.join(lock, "owner.json"), "wx", 0o600);
    try { await owner.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
    finally { await owner.close(); }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await privateDirectory(path.dirname(destination));
    await mkdir(destination, { mode: 0o700 });
    created = true;
    const destinationLock = path.join(destination, ".operation-lock");
    await mkdir(destinationLock, { mode: 0o700 });
    let entries = 0;
    let snapshots = 0;
    let bytes = 0;
    for await (const entry of await opendir(source)) {
      if (++entries > 1024) throw new Error("Snapshot copy exceeds the directory entry limit.");
      if (!SNAPSHOT_ID.test(entry.name)) continue;
      if (++snapshots > 64) throw new Error("Snapshot copy exceeds the 64 snapshot limit.");
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      await privateDirectory(from);
      await mkdir(to, { mode: 0o700 });
      let manifest = false;
      for await (const artifact of await opendir(from)) {
        if (!ARTIFACTS.has(artifact.name)) throw new Error("Unexpected file in snapshot evidence.");
        const input = await open(path.join(from, artifact.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await input.stat();
          bytes += info.size;
          if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
            throw new Error("Snapshot copy requires owned, private regular files without links.");
          }
          if (info.size > MAX_FILE_BYTES || bytes > MAX_BYTES) throw new Error("Snapshot copy exceeds the evidence byte limit.");
          const output = await open(path.join(to, artifact.name), "wx", 0o600);
          try { await output.writeFile(await input.readFile()); }
          finally { await output.close(); }
          if (artifact.name === "manifest.json") manifest = true;
        } finally { await input.close(); }
      }
      if (!manifest) throw new Error("Snapshot copy found evidence without a manifest.");
    }
    await rmdir(destinationLock);
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(path.join(lock, "owner.json"), { force: true });
    await rmdir(lock);
  }
}
