import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { SnapshotStore } from "../src/snapshots.ts";
import { createWebReadTool } from "../src/web/read.ts";

const context = {} as ExtensionToolContext;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "web-read-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SnapshotStore({ directory });
  return { store, tool: createWebReadTool(store) };
}

test("web_read validates exact formats and reads saved evidence without network or host paths", async t => {
  const { store, tool } = await fixture(t);
  const info = await store.save({ kind: "fetch", metadata: { url: "https://example.test" }, md: "# Saved", text: "Saved", html: "<h1>Saved</h1>" });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network must not be accessed"); });
  assert.equal(tool.name, "web_read");
  const formatSchema = JSON.parse(JSON.stringify(tool.parameters)).properties.format;
  assert.equal(formatSchema.type, "string");
  assert.deepEqual(formatSchema.enum, ["md", "text", "html", "json", "screenshot", "before-screenshot"]);
  assert.equal(formatSchema.anyOf, undefined);
  for (const format of ["md", "text", "html", "json", "screenshot", "before-screenshot"]) assert.ok(Check(tool.parameters, { snapshot: info.id, format }));
  for (const params of [{ snapshot: "/etc/passwd" }, { snapshot: info.id, format: "before-html" }, { snapshot: info.id, phase: "before" }, { snapshot: info.id, url: "https://example.test" }]) assert.ok(!Check(tool.parameters, params));
  const result = await tool.execute("read", { snapshot: info.id }, undefined, undefined, context);
  assert.equal(result.details.format, "md");
  assert.equal(result.details.snapshot, info.id);
  assert.deepEqual(result.details.available, info.available);
  assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /# Saved$/);
  assert.ok(!JSON.stringify(result).includes(store.directory));
  assert.ok(!JSON.stringify(result.details).includes("paths"));
  await assert.rejects(tool.execute("read", { snapshot: info.id, format: "screenshot" }, undefined, undefined, context), /unavailable.*md, text, html, json/);
});

test("web_read text pages remain within total byte/line bounds and expose usable continuation", async t => {
  const { store, tool } = await fixture(t);
  const info = await store.save({ kind: "browser", metadata: {}, md: "😀".repeat(30_000) + "\n" + "line\n".repeat(4000), warnings: Array.from({ length: 16 }, () => "warning ".repeat(100)) });
  let cursor: string | undefined;
  let pages = 0;
  do {
    const result = await tool.execute("read", { snapshot: info.id, cursor }, undefined, undefined, context);
    const text = result.content.map(block => block.type === "text" ? block.text : "").join("\n");
    assert.ok(Buffer.byteLength(text) <= 50 * 1024);
    assert.ok(text.split("\n").length <= 2000);
    assert.ok(!text.includes("�"));
    cursor = result.details.nextCursor;
    if (cursor) assert.ok(text.includes(`nextCursor: ${cursor}`));
    pages++;
  } while (cursor);
  assert.ok(pages >= 4);
});

test("web_read JSON output is valid JSON on every page, including continuation and warnings", async t => {
  const { store, tool } = await fixture(t);
  const data = { pageExample: { password: "example", path: "/docs/example", auth: { cookie: "example cookie" } }, rawResponse: { output: "😀\\\n\"".repeat(20_000) }, results: [{ title: "Example", url: "https://example.test/" }] };
  const info = await store.save({ kind: "search", metadata: { query: "test" }, json: data, warnings: Array.from({ length: 16 }, () => '\\"\u0000\u0001'.repeat(100)) });
  let cursor: string | undefined;
  let document = "";
  do {
    const result = await tool.execute("read", { snapshot: info.id, format: "json", cursor }, undefined, undefined, context);
    assert.equal(result.content.length, 1);
    assert.ok(!JSON.stringify(result.details).includes(store.directory));
    assert.ok(!Object.hasOwn(result.details, "paths"));
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.ok(Buffer.byteLength(text) <= 50 * 1024);
    const envelope = JSON.parse(text);
    assert.equal(envelope.encoding, "json-text");
    assert.equal(envelope.snapshot, info.id);
    assert.deepEqual(envelope.warnings, info.warnings);
    document += envelope.chunk;
    cursor = result.details.nextCursor;
    assert.equal(envelope.nextCursor, cursor);
  } while (cursor);
  assert.deepEqual(JSON.parse(document).data, data);
});

test("web_read screenshot formats emit native PNG blocks, never base64 text or file paths", async t => {
  const { store, tool } = await fixture(t);
  const info = await store.save({ kind: "browser", metadata: {}, screenshot: PNG, beforeScreenshot: PNG });
  for (const format of ["screenshot", "before-screenshot"] as const) {
    const result = await tool.execute("image", { snapshot: info.id, format }, undefined, undefined, context);
    assert.deepEqual(result.content[1], { type: "image", data: PNG, mimeType: "image/png" });
    assert.ok(!JSON.stringify(result.details).includes(PNG));
    assert.ok(!JSON.stringify(result).includes(store.directory));
    assert.ok(!result.content.some(block => block.type === "text" && block.text.includes(PNG)));
    await assert.rejects(tool.execute("image", { snapshot: info.id, format, cursor: "0." + "0".repeat(64) }, undefined, undefined, context), /Invalid cursor/);
  }
});

test("web_read reports expired snapshots and honors cancellation without exposing filesystem errors", async t => {
  const { store, tool } = await fixture(t);
  const id = `snap_${"0".repeat(32)}`;
  await assert.rejects(tool.execute("gone", { snapshot: id }, undefined, undefined, context), /expired or is not present/);
  const info = await store.save({ kind: "fetch", metadata: {}, md: "saved" });
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(tool.execute("cancel", { snapshot: info.id }, controller.signal, undefined, context), /cancelled/);
  await rm(path.join(store.directory, info.id, "content.md"));
  await assert.rejects(tool.execute("missing-file", { snapshot: info.id }, undefined, undefined, context), error => error instanceof Error && !error.message.includes(store.directory) && /unavailable/.test(error.message));
});
