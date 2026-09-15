import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SnapshotError, SnapshotStore, snapshotSummary, type SnapshotFormat } from "../src/snapshots.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
async function fixture(t: TestContext, options: { maxSnapshots?: number; maxBytes?: number } = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "snapshot-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return new SnapshotStore({ directory: path.join(parent, "evidence"), ...options });
}
async function complete(store: SnapshotStore, id: string, format: SnapshotFormat): Promise<string> {
  let cursor: string | undefined;
  let text = "";
  do {
    const page = await store.read(id, format, cursor);
    text += format === "json" ? JSON.parse(page.text!).chunk : page.text;
    cursor = page.nextCursor;
  } while (cursor);
  return text;
}

test("snapshot storage is lazy, private, persisted, and detached from producer mutations", async t => {
  const store = await fixture(t);
  await assert.rejects(lstat(store.directory), { code: "ENOENT" });
  const input = { kind: "fetch" as const, metadata: { url: "https://example.test/", title: "Original" }, md: "# Original\n世界😀", html: "<h1>Original</h1>", json: { links: [{ url: "https://example.test/link" }] }, screenshot: PNG, beforeScreenshot: PNG };
  const saving = store.save(input);
  input.md = "Changed";
  input.metadata.title = "Changed";
  input.json.links[0]!.url = "https://changed.test/";
  const info = await saving;
  assert.match(info.id, /^snap_[a-f0-9]{32}$/);
  assert.deepEqual(info.available, ["md", "text", "html", "json", "screenshot", "before-screenshot"]);
  assert.equal((await lstat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(store.directory, info.id))).mode & 0o777, 0o700);
  for (const filename of Object.values(info.paths)) assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  const restored = new SnapshotStore({ directory: store.directory });
  assert.deepEqual(await restored.info(info.id), info);
  assert.equal((await restored.read(info.id)).text, "# Original\n世界😀");
  assert.equal((await restored.read(info.id, "text")).text, "# Original\n世界😀");
  assert.match(info.warnings.join(" "), /Markdown fallback/);
  const json = JSON.parse(await complete(restored, info.id, "json"));
  assert.equal(json.metadata.title, "Original");
  assert.equal(json.data.links[0].url, "https://example.test/link");
  assert.equal(json.snapshot, info.id);
  assert.deepEqual(json.available, info.available);
  for (const format of ["screenshot", "before-screenshot"] as const) assert.deepEqual((await restored.read(info.id, format)).image, { data: PNG, mimeType: "image/png" });
  assert.ok(!snapshotSummary(info).includes(store.directory));
  info.available.length = 0;
  info.warnings.push("mutated");
  assert.equal((await restored.info(info.id)).available.length, 6);
});

test("structured page evidence preserves credential-like and path field names faithfully", async t => {
  const store = await fixture(t);
  const page = { password: "example password", path: "/docs/example", paths: ["/public/page"], auth: { cookie: "example cookie", authorization: "example header" }, credentials: { api_key: "documentation example", refresh_token: "example" }, screenshotPath: "page-defined value", cursorKey: "page-defined key" };
  const info = await store.save({ kind: "browser", metadata: page, json: { eval: page } });
  const json = JSON.parse(await complete(store, info.id, "json"));
  assert.deepEqual(json.metadata, page);
  assert.deepEqual(json.data.eval, page);
  assert.deepEqual(info.warnings, []);
  assert.ok(!JSON.stringify(json).includes(store.directory));
});

test("structured keys sharing long prefixes remain distinct, including Unicode and escaped keys", async t => {
  const store = await fixture(t);
  const page: Record<string, unknown> = {};
  for (const prefix of ["x".repeat(256), "😀".repeat(64), "\"\\\n".repeat(100)]) {
    page[prefix] = "prefix";
    page[`${prefix}first`] = "first";
    page[`${prefix}second`] = "second";
  }
  const info = await store.save({ kind: "browser", metadata: page, json: { nested: page } });
  const json = JSON.parse(await complete(store, info.id, "json"));
  assert.deepEqual(json.metadata, page);
  assert.deepEqual(json.data.nested, page);
  assert.deepEqual(info.warnings, []);
});

test("oversized structured keys omit entire entries with a warning, without renaming or losing later keys", async t => {
  const store = await fixture(t, { maxBytes: 64 * 1024 });
  const key = "😀\"\\\n".repeat(10_000);
  const info = await store.save({ kind: "fetch", metadata: {}, json: { [key]: "omitted", kept: "value" } });
  const json = JSON.parse(await complete(store, info.id, "json"));
  assert.deepEqual(json.data, { kept: "value" });
  assert.match(info.warnings.join(" "), /entries with oversized keys omitted.*keys are never truncated/);
  assert.ok(Buffer.byteLength(JSON.stringify(json)) < 64 * 1024);
});

test("Unicode-safe cursors bind snapshot and format and survive fresh store objects", async t => {
  const store = await fixture(t);
  const md = ("😀世界é".repeat(4500) + "\n").repeat(3) + "line\n".repeat(2400);
  const info = await store.save({ kind: "browser", metadata: {}, md, text: md });
  const first = await store.read(info.id);
  assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(first.text!) <= 44 * 1024);
  assert.ok(!first.text!.includes("�"));
  const restored = new SnapshotStore({ directory: store.directory });
  assert.deepEqual(await restored.read(info.id, "md", first.nextCursor), await store.read(info.id, "md", first.nextCursor));
  assert.equal(await complete(restored, info.id, "md"), md);
  await assert.rejects(restored.read(info.id, "text", first.nextCursor), { code: "invalid-cursor" });
  const other = await restored.save({ kind: "fetch", metadata: {}, md });
  await assert.rejects(restored.read(other.id, "md", first.nextCursor), { code: "invalid-cursor" });
  for (const cursor of ["../manifest.json", "123.bad", `0.${"0".repeat(64)}`, `${first.nextCursor}x`]) {
    await assert.rejects(restored.read(info.id, "md", cursor), { code: "invalid-cursor" });
  }
});

test("JSON pages are valid bounded envelopes that reconstruct complete structured evidence", async t => {
  const store = await fixture(t);
  const value = { text: ('\\\"\t\n😀世界'.repeat(10_000)), links: [{ title: "source", url: "https://example.test/" }] };
  const info = await store.save({ kind: "search", metadata: { query: "query" }, json: value });
  const first = await store.read(info.id, "json");
  assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(first.text!) < 45 * 1024);
  const restored = new SnapshotStore({ directory: store.directory });
  assert.deepEqual(JSON.parse(await complete(restored, info.id, "json")).data, value);
  await assert.rejects(restored.read(info.id), /md unavailable.*json/);
  await assert.rejects(restored.read(info.id, "html"), { code: "unavailable" });
});

test("capture limits, structured omission, image limits, and byte quota are explicit", async t => {
  const store = await fixture(t, { maxBytes: 64 * 1024 });
  const cycle: Record<string, unknown> = { value: "kept" };
  cycle.self = cycle;
  const oversizedPng = Buffer.from(PNG, "base64");
  oversizedPng.writeUInt32BE(10_000, 16);
  const info = await store.save({ kind: "browser", metadata: { url: "https://example.test" },
    md: "😀".repeat(100_000), html: "<p>".repeat(100_000), json: { cycle, huge: "x".repeat(100_000) },
    screenshot: "not png", beforeScreenshot: oversizedPng.toString("base64"), warnings: Array.from({ length: 50 }, () => "warning\n".repeat(100)) });
  assert.match(info.warnings.join(" "), /md truncated/);
  assert.match(info.warnings.join(" "), /html truncated/);
  assert.match(info.warnings.join(" "), /Structured JSON truncated/);
  assert.match(info.warnings.join(" "), /screenshot omitted/);
  assert.match(info.warnings.join(" "), /before-screenshot omitted/);
  assert.match(info.warnings.join(" "), /Additional capture warnings omitted/);
  const json = await complete(store, info.id, "json");
  assert.ok(!json.includes(store.directory));
  const parsed = JSON.parse(json);
  assert.equal(parsed.metadata.url, "https://example.test");
  assert.equal(parsed.data.cycle.value, "kept");
  assert.equal(parsed.data.cycle.self, null);
  let bytes = 0;
  for (const filename of await readdir(path.join(store.directory, info.id))) bytes += (await lstat(path.join(store.directory, info.id, filename))).size;
  assert.ok(bytes <= 64 * 1024);
  await assert.rejects(store.read(info.id, "screenshot"), /screenshot unavailable/);
});

test("images above 1 MiB are omitted with an explicit byte-limit warning", async t => {
  const store = await fixture(t);
  const data = Buffer.alloc(1024 * 1024 + 1);
  Buffer.from(PNG, "base64").copy(data);
  const info = await store.save({ kind: "browser", metadata: {}, screenshot: data.toString("base64"), beforeScreenshot: PNG });
  assert.ok(!info.available.includes("screenshot"));
  assert.ok(info.available.includes("before-screenshot"));
  assert.match(info.warnings.join(" "), /screenshot omitted:.*1048576 bytes/);
  await assert.rejects(store.read(info.id, "screenshot"), /screenshot unavailable/);
});

test("count and byte eviction survive reload and yield explicit expired reports", async t => {
  const store = await fixture(t, { maxSnapshots: 1 });
  const first = await store.save({ kind: "fetch", metadata: {}, md: "First" });
  const second = await store.save({ kind: "fetch", metadata: {}, md: "Second" });
  const restored = new SnapshotStore({ directory: store.directory, maxSnapshots: 1 });
  await assert.rejects(restored.read(first.id), { code: "expired" });
  assert.equal((await restored.read(second.id)).text, "Second");
  assert.deepEqual(await readdir(store.directory), [second.id]);
  const limited = await fixture(t, { maxBytes: 64 * 1024, maxSnapshots: 100 });
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) ids.push((await limited.save({ kind: "fetch", metadata: {}, md: "m".repeat(9000), html: "h".repeat(9000) })).id);
  await assert.rejects(limited.info(ids[0]!), { code: "expired" });
  assert.ok((await limited.info(ids.at(-1)!)).available.includes("md"));
  const diskEntries = await readdir(limited.directory);
  let bytes = 0;
  for (const entry of diskEntries) for (const file of await readdir(path.join(limited.directory, entry))) bytes += (await lstat(path.join(limited.directory, entry, file))).size;
  assert.ok(bytes <= 64 * 1024);
});

test("snapshot IDs cannot open paths and private storage rejects symlinks and unsafe files", async t => {
  const store = await fixture(t);
  for (const id of ["../../etc/passwd", "/etc/passwd", "snap_" + "a".repeat(32) + "/../", "snap_" + "A".repeat(32)]) {
    assert.throws(() => store.info(id), { code: "invalid-id" });
    assert.throws(() => store.read(id), { code: "invalid-id" });
  }
  const info = await store.save({ kind: "fetch", metadata: {}, md: "private" });
  const outside = path.join(path.dirname(store.directory), "outside.txt");
  await writeFile(outside, "OUTSIDE_SECRET", { mode: 0o600 });
  await rm(info.paths.md!);
  await symlink(outside, info.paths.md!);
  await assert.rejects(store.read(info.id), error => error instanceof SnapshotError && !error.message.includes(store.directory));
  assert.equal(await readFile(outside, "utf8"), "OUTSIDE_SECRET");
  await rm(info.paths.md!);
  await writeFile(info.paths.md!, "private", { mode: 0o644 });
  await assert.rejects(store.read(info.id), { code: "unsafe-store" });
  await chmod(store.directory, 0o755);
  await assert.rejects(store.info(info.id), { code: "unsafe-store" });
  await chmod(store.directory, 0o700);
  const link = path.join(path.dirname(store.directory), "linked");
  await symlink(store.directory, link);
  await assert.rejects(new SnapshotStore({ directory: link }).info(info.id), { code: "unsafe-store" });
});

test("other pending publications are untouched and tiny quotas fail without publishing", async t => {
  const store = await fixture(t);
  const first = await store.save({ kind: "fetch", metadata: {}, md: "kept" });
  const abandoned = path.join(store.directory, `.pending-snap_${"a".repeat(32)}`);
  await mkdir(abandoned, { mode: 0o700 });
  await writeFile(path.join(abandoned, "content.md"), "partial", { mode: 0o600 });
  const restored = new SnapshotStore({ directory: store.directory });
  await restored.save({ kind: "fetch", metadata: {}, md: "new" });
  assert.equal(await readFile(path.join(abandoned, "content.md"), "utf8"), "partial");
  assert.equal((await restored.read(first.id)).text, "kept");
  for (const maxBytes of [1, 2, 16, 128, 512, 1023]) {
    const tiny = await fixture(t, { maxBytes });
    await assert.rejects(tiny.save({ kind: "fetch", metadata: {}, md: "cannot fit😀" }), /byte quota/);
    await assert.rejects(lstat(tiny.directory), { code: "ENOENT" });
  }
});

test("store objects order reads before eviction and obey the shared quota", async t => {
  const store = await fixture(t, { maxSnapshots: 1 });
  const other = new SnapshotStore({ directory: store.directory, maxSnapshots: 1 });
  const first = await store.save({ kind: "fetch", metadata: {}, md: "first" });
  const reading = other.read(first.id);
  const saving = store.save({ kind: "fetch", metadata: {}, md: "second" });
  assert.equal((await reading).text, "first");
  const second = await saving;
  assert.deepEqual(await readdir(store.directory), [second.id]);
  await assert.rejects(other.info(first.id), { code: "expired" });
});

test("an active cross-process read excludes reads, eviction, and publication", { timeout: 15_000 }, async t => {
  const store = await fixture(t, { maxSnapshots: 1 });
  const first = await store.save({ kind: "fetch", metadata: {}, md: "first" });
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { once } from 'node:events';
    import { SnapshotStore } from ${JSON.stringify(new URL("../src/snapshots.ts", import.meta.url).href)};
    const store = new SnapshotStore({ directory: process.argv[1] });
    const manifest = store.manifest.bind(store);
    store.manifest = async id => {
      const value = await manifest(id);
      const release = once(process, 'message');
      process.send('locked');
      await release;
      return value;
    };
    const result = await store.read(process.argv[2]);
    process.send(result.text);
    process.disconnect();
  `, store.directory, first.id], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  assert.equal((await once(child, "message"))[0], "locked");
  assert.equal((await lstat(path.join(store.directory, ".operation-lock"))).mode & 0o777, 0o700);
  for (const operation of [() => store.read(first.id), () => store.info(first.id), () => store.save({ kind: "fetch", metadata: {}, md: "replacement" })]) {
    await assert.rejects(operation(), error => error instanceof SnapshotError && error.code === "owned" && !error.message.includes(store.directory));
  }
  assert.equal(await readFile(first.paths.md!, "utf8"), "first");
  const result = once(child, "message");
  child.send("release");
  assert.equal((await result)[0], "first");
  assert.equal((await exited)[0], 0, stderr);
  const second = await store.save({ kind: "fetch", metadata: {}, md: "second" });
  assert.deepEqual(await readdir(store.directory), [second.id]);
});

test("existing operation locks are never reclaimed automatically", async t => {
  const store = await fixture(t);
  const first = await store.save({ kind: "fetch", metadata: {}, md: "first" });
  const lock = path.join(store.directory, ".operation-lock");
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(store.read(first.id), { code: "owned" });
  await assert.rejects(store.save({ kind: "fetch", metadata: {}, md: "second" }), { code: "owned" });
  assert.ok((await lstat(lock)).isDirectory());
  assert.equal(await readFile(first.paths.md!, "utf8"), "first");
});

test("parallel saves across store objects publish complete immutable snapshots", async t => {
  const store = await fixture(t);
  const infos = await Promise.all(Array.from({ length: 12 }, (_, index) => new SnapshotStore({ directory: store.directory }).save({ kind: "fetch", metadata: { index }, md: `capture ${index}` })));
  assert.equal(new Set(infos.map(info => info.id)).size, 12);
  assert.equal((await readdir(store.directory)).filter(name => name.startsWith(".pending-")).length, 0);
  for (let index = 0; index < infos.length; index++) assert.equal((await store.read(infos[index]!.id)).text, `capture ${index}`);
});
