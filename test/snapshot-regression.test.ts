import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { SnapshotStore } from "../src/snapshots.ts";
import { BrowserProcessLauncher, publicBrowserError } from "../src/core/process.ts";
import { createWebTools } from "../src/web/index.ts";

const context = {} as ExtensionToolContext;

test("JSON preserves fitting long strings and treats undefined object fields as absent", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-snapshot-json-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SnapshotStore({ directory, maxBytes: 8 * 1024 * 1024 });
  const large = "x".repeat(1024 * 1024);
  const info = await store.save({ kind: "fetch", metadata: { optional: undefined }, json: { large } });
  const saved = JSON.parse(await readFile(info.paths.json!, "utf8"));
  assert.equal(saved.data.large, large);
  assert(!("optional" in saved.metadata));
  assert.deepEqual(info.warnings, []);
});

test("public host failure snapshots omit native paths and profile-owner diagnostics", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-snapshot-host-failure-"));
  const store = new SnapshotStore({ directory: path.join(directory, "snapshots") });
  const profile = path.join(directory, "private-profile");
  const owner = await BrowserProcessLauncher.create({ browser: "firefox", executable: "/bin/false", headless: true, profileDir: path.join(profile, "firefox") });
  const web = createWebTools({ snapshots: store, settings: { backend: "browser", browser: "firefox", headless: true, executable: "/bin/false", profileDir: profile } });
  t.after(async () => { await web.close(); await owner.close(); await rm(directory, { recursive: true, force: true }); });
  let id = "";
  await assert.rejects(web.tools[1].execute("owned", { url: "https://example.test/" }, undefined, undefined, context), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /already owned/);
    assert(!error.message.includes(directory));
    id = /Snapshot: (snap_[a-f0-9]{32})/.exec(error.message)?.[1] ?? "";
    assert(id);
    return true;
  });
  const json = await readFile((await store.info(id)).paths.json!, "utf8");
  assert(!json.includes(directory));
  assert(!json.includes("browserPid"));
  const native = Object.assign(new Error(`ENOENT: ${directory}/secret`), { code: "ENOENT", path: `${directory}/secret` });
  assert(!publicBrowserError(native).includes(directory));
});
