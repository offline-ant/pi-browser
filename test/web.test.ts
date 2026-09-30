import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { createWebTools, SnapshotStore } from "../src/web/index.ts";
import { CODEX_ENDPOINT, CodexUnavailable, formatCodex, runCodex } from "../src/web/codex.ts";
import { resolveWebSettings } from "../src/web/settings.ts";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
function context(auth: () => Promise<string | undefined> = async () => token): ExtensionToolContext {
  return { modelRegistry: { getApiKeyForProvider: auth }, model: undefined } as unknown as ExtensionToolContext;
}
function isolateCredentials(t: TestContext, directory: string): void {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
}

test("web settings are host-only, validated, and default to Codex-first auto", () => {
  const defaults = resolveWebSettings({}, {});
  assert.equal(defaults.backend, "auto");
  assert.equal(defaults.browser, "chromium");
  assert.equal(defaults.searchEngine, "duckduckgo");
  assert.equal(defaults.headless, false);
  assert.notEqual(defaults.profileDir, resolveWebSettings({}, {}).profileDir, "anonymous SDK clients need independent profile leases");
  assert.equal(resolveWebSettings({}, {}, "/tmp/host-profile").profileDir, "/tmp/host-profile");
  const env = { PI_WEB_BACKEND: "browser", PI_WEB_BROWSER: "firefox", PI_WEB_SEARCH_ENGINE: "bing", PI_BROWSER_HEADLESS: "1", PI_WEB_PROFILE_DIR: "/tmp/profile" };
  assert.deepEqual(resolveWebSettings({}, env), { backend: "browser", browser: "firefox", searchEngine: "bing", headless: true, profileDir: "/tmp/profile" });
  assert.equal(resolveWebSettings({ backend: "codex" }, env).backend, "codex");
  assert.equal(resolveWebSettings({}, env, "/tmp/host-profile").profileDir, "/tmp/profile");
  for (const environment of [{ PI_WEB_BACKEND: "typo" }, { PI_WEB_BROWSER: "chrome" }, { PI_WEB_SEARCH_ENGINE: "typo" }, { PI_BROWSER_HEADLESS: "yes" }, { PI_WEB_PROFILE_DIR: "" }, { PI_BROWSER_EXECUTABLE: "" }]) {
    assert.throws(() => resolveWebSettings({}, environment));
  }
});

test("Codex web tools preserve request/auth semantics, surface errors, and do not expose backend arguments", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-browser-codex-test-"));
  isolateCredentials(t, directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const set = createWebTools({ settings: { backend: "codex" }, snapshots: new SnapshotStore({ directory: path.join(directory, "snapshots") }) });
  t.after(() => set.close());
  const [search, fetchTool] = set.tools;
  assert.deepEqual(set.tools.map(tool => tool.name), ["web_search", "web_fetch", "web_read"]);
  assert.ok(Check(search!.parameters, { query: "test", max_results: 20 }));
  assert.ok(!Check(search!.parameters, { query: "test", max_results: 21 }));
  assert.ok(!Check(search!.parameters, { query: "test", backend: "browser" }));
  assert.ok(!Check(fetchTool!.parameters, { url: "https://example.com", browser: "firefox" }));
  const calls: { url: string; init?: RequestInit }[] = [];
  let respond: (init?: RequestInit) => Promise<Response> = async () => Response.json({ output: "[A source](https://example.com/article)" });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return respond(init); });
  await t.test("search and fetch issue Codex commands with current model and source metadata", async () => {
    const result = await search!.execute("search", { query: "  research query  ", max_results: 3 }, undefined, undefined, context());
    assert.equal(result.details.backend, "codex");
    assert.match(result.content.map(part => part.type === "text" ? part.text : "").join(""), /A source/);
    const call = calls.at(-1)!;
    assert.equal(call.url, CODEX_ENDPOINT);
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(headers.get("ChatGPT-Account-ID"), "test-account");
    assert.equal(headers.get("originator"), "pi-browser");
    const request = JSON.parse(String(call.init?.body));
    assert.deepEqual(request.commands, { search_query: [{ q: "research query" }], response_length: "short" });
    assert.equal(request.model, "gpt-5.6-sol");
    assert.equal(request.max_output_tokens, 8000);
    assert.deepEqual(request.settings, { allowed_callers: ["direct"], external_web_access: true });
    const ctx = { ...context(), model: { provider: "openai-codex", id: "chosen-model" } } as ExtensionToolContext;
    const fetched = await fetchTool!.execute("fetch", { url: " https://example.com/article " }, undefined, undefined, ctx);
    assert.equal(fetched.details.model, "chosen-model");
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)).commands, { open: [{ ref_id: "https://example.com/article" }], response_length: "long" });
  });
  await t.test("default search returns ten compact results and preserves all sources and raw response in the injected store", async () => {
    const results = Array.from({ length: 14 }, (_, index) => ({ type: "text_result", domain: "example.test", ref_id: `turn0search${index}`,
      title: `Source ${index + 1}`, url: `https://example.test/${index + 1}`, snippet: `${"Long excerpt ".repeat(80)} final marker ${index + 1}` }));
    const output = results.map(result => `${result.title} (${result.url})\ncite${result.ref_id} [wordlim: 200] Crawled: today; ${result.snippet}`).join("\n" + "-".repeat(80) + "\n");
    const response = { encrypted_output: "synthetic opaque output", output, results };
    respond = async () => Response.json(response);
    const result = await search!.execute("default", { query: "fixture" }, undefined, undefined, context());
    assert.equal(result.details.sourceCount, 14);
    assert.equal(result.details.returnedCount, 10);
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)).commands, { search_query: [{ q: "fixture" }], response_length: "long" });
    const preview = result.content.map(part => part.type === "text" ? part.text : "").join("");
    assert.match(preview, /10\. \[Source 10\]\(<https:\/\/example.test\/10>\)/);
    assert.doesNotMatch(preview, /Source 11|final marker/);
    assert.match(preview, /10 selected \/ 14 captured/);
    assert.ok(preview.length < 8000);
    const id = result.details.snapshot!;
    const saved = await set.snapshots.read(id, "json");
    let json = JSON.parse(saved.text!).chunk;
    let cursor = saved.nextCursor;
    while (cursor) {
      const page = await set.snapshots.read(id, "json", cursor);
      json += JSON.parse(page.text!).chunk;
      cursor = page.nextCursor;
    }
    const document = JSON.parse(json);
    assert.deepEqual(document.data.response, response);
    assert.equal(document.data.results.length, 14);
    assert.ok(!saved.text!.includes(token));
    assert.deepEqual(result.details.available, ["md", "text", "json"]);
    await assert.rejects(set.snapshots.read(id, "html"), /unavailable/);
    assert.match((await set.snapshots.read(id, "md")).text!, /Source 14/);
    const plain = await set.snapshots.read(id, "text");
    assert.match(plain.text!, /1\. Source 1\nhttps:\/\/example.test\/1/);
    assert.doesNotMatch(plain.warnings.join(" "), /Markdown fallback/);
  });
  await t.test("input errors never reach credentials/transport", async () => {
    const before = calls.length;
    const ctx = context(async () => { throw new Error("Auth should not be consulted"); });
    await assert.rejects(search!.execute("invalid", { query: " " }, undefined, undefined, ctx), /query must not be empty/);
    await assert.rejects(search!.execute("invalid", { query: "test", max_results: 21 }, undefined, undefined, ctx), /max_results/);
    for (const url of ["file:///etc/passwd", "https://user:pass@example.com/", "not a url"]) await assert.rejects(fetchTool!.execute("invalid", { url }, undefined, undefined, ctx), /Invalid URL/);
    assert.equal(calls.length, before);
  });
  await t.test("explicit Codex reports unavailable credentials rather than opening a browser", async () => {
    await assert.rejects(fetchTool!.execute("no-auth", { url: "https://example.com/" }, undefined, undefined, context(async () => undefined)), /No OpenAI Codex OAuth token/);
    await assert.rejects(fetchTool!.execute("expired", { url: "https://example.com/" }, undefined, undefined, context(async () => { throw new Error("Refresh token expired"); })), /Refresh token expired/);
    await assert.rejects(runCodex("fetch", "https://example.com/", 5, context(async () => "bad-token")), CodexUnavailable);
  });
  await t.test("availability errors are distinguished from malformed or invalid requests", async () => {
    for (const status of [401, 403, 404, 405, 408, 429, 500, 503]) {
      respond = async () => new Response("unavailable", { status });
      await assert.rejects(runCodex("fetch", "https://example.com/", 5, context()), CodexUnavailable);
    }
    respond = async () => new Response("unsupported model", { status: 400 });
    await assert.rejects(runCodex("search", "query", 5, context()), CodexUnavailable);
    respond = async () => new Response("invalid request", { status: 400 });
    await assert.rejects(runCodex("search", "query", 5, context()), error => error instanceof Error && !(error instanceof CodexUnavailable));
    respond = async () => new Response("not json");
    await assert.rejects(runCodex("fetch", "https://example.com/", 5, context()), /invalid JSON/);
    respond = async () => Response.json({ encrypted_output: "opaque" });
    await assert.rejects(runCodex("fetch", "https://example.com/", 5, context()), /missing output/);
    respond = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(runCodex("fetch", "https://example.com/", 5, context()), CodexUnavailable);
  });
  await t.test("truncation is explicit and bounded", async () => {
    respond = async () => Response.json({ output: "source line\n".repeat(2300) });
    const lines = await search!.execute("large", { query: "query" }, undefined, undefined, context());
    assert.equal(lines.details.truncated, true);
    assert.match(lines.content.map(part => part.type === "text" ? part.text : "").join(""), /Output truncated/);
    respond = async () => Response.json({ output: "x".repeat(60 * 1024) });
    const bytes = await fetchTool!.execute("large", { url: "https://example.com/" }, undefined, undefined, context());
    assert.equal(bytes.details.truncated, true);
    assert.ok(Buffer.byteLength(bytes.content.map(part => part.type === "text" ? part.text : "").join("")) < 51 * 1024);
  });
  await t.test("auto mode propagates progress errors and callback cancellation before browser launch", async () => {
    respond = async () => new Response("unavailable", { status: 503 });
    const failed = createWebTools({ settings: { backend: "auto" }, onProgress: () => { throw new Error("progress failure"); } });
    const abort = new AbortController();
    const cancelled = createWebTools({ settings: { backend: "auto" }, onProgress: () => abort.abort(new Error("cancelled by progress")) });
    try {
      await assert.rejects(failed.tools[0]!.execute("progress", { query: "query" }, undefined, undefined, context()), /progress failure/);
      await assert.rejects(cancelled.tools[0]!.execute("cancel-progress", { query: "query" }, abort.signal, undefined, context()), /cancelled by progress/);
      const malformed = createWebTools({ settings: { backend: "auto" } });
      try {
        respond = async () => Response.json({ noOutput: true });
        await assert.rejects(malformed.tools[0]!.execute("malformed", { query: "query" }, undefined, undefined, context()), /missing output/);
      } finally { await malformed.close(); }
    } finally { await failed.close(); await cancelled.close(); }
  });
  await t.test("abort is not availability failure, including an uncooperative auth resolver", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    respond = async () => { ready(); return new Promise<Response>(() => {}); };
    const pending = runCodex("fetch", "https://example.com/", 5, context(), controller.signal);
    const rejected = assert.rejects(pending, /test cancellation/);
    await started;
    controller.abort(new Error("test cancellation"));
    await rejected;
    const authAbort = new AbortController();
    const waiting = runCodex("fetch", "https://example.com/", 5, context(() => new Promise(() => {})), authAbort.signal);
    const cancelled = assert.rejects(waiting, /auth cancelled/);
    authAbort.abort(new Error("auth cancelled"));
    await cancelled;
  });
});

test("Codex formatting is conservative about headers, opaque refs, wrapper prefixes, and code", () => {
  const body = ["# Article", "See 【0†a linked label】 and cite citeturn0view0.", "", "```js", "  const label = '【1†not a link】';", "L42: keep this code prefix", "", "```", "`【2†inline code】`", "    【3†indented code】", "[Real link](https://example.test/real)"].join("\n");
  const wrapped = `Article (https://example.test/article)\n【turn0view0】 [wordlim: 200] Content type: text/html; Source: open({"ref_id":"https://example.test/article","lineno":null}); Total lines: 11\n${body.split("\n").map((line, index) => `L${index}: ${line}`).join("\n")}`;
  const fetched = formatCodex("fetch", { output: wrapped }, 10);
  assert.equal(fetched.md, body.replace("【0†a linked label】", "a linked label"));
  assert.match(fetched.warnings.join(" "), /unknown references/);
  assert.doesNotMatch(fetched.md, /https:\/\/example.test\/0|Content type:/);
  for (const output of ["L0: ordinary prose\nL1: not a known wrapper", "[Linked prose](https://example.test/)", "Unknown result (https://example.test/)\nNo provider header", wrapped.replace("L1:", "unknown:")]) {
    for (const kind of ["search", "fetch"] as const) {
      const result = formatCodex(kind, { output }, 1);
      assert.equal(result.md, output);
      assert.equal(result.sourceCount, undefined);
      assert.match(result.warnings.join(" "), /raw preview/);
    }
  }
  const mixed = "First (https://example.test/first)\n【turn0search0】 [wordlim: 200]\nSnippet\n\nUnsafe (https://user:password@example.test/)\n【turn0search1】 [wordlim: 200]\nOther snippet";
  assert.equal(formatCodex("search", { output: mixed }, 1).sourceCount, undefined, "do not report partial parsing as a reliable count");
});

test("Codex snapshots remain readable offline after close; missing formats never change backend", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-web-codex-snapshot-"));
  isolateCredentials(t, directory);
  const snapshots = new SnapshotStore({ directory: path.join(directory, "snapshots") });
  const set = createWebTools({ snapshots, settings: { backend: "auto" } });
  t.after(async () => { await set.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(set.snapshots, snapshots);
  const response = { output: "Unknown opaque result 【turn0view0】 [wordlim: 200]", provenance: { ref: "turn0view0" } };
  const transport = t.mock.method(globalThis, "fetch", async () => Response.json(response));
  const result = await set.tools[1].execute("fetch", { url: "https://example.test/" }, undefined, undefined, context());
  const id = result.details.snapshot!;
  assert.equal(result.details.backend, "codex");
  assert.match(JSON.stringify(result.content), /raw preview/);
  await set.close();
  transport.mock.restore();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline; no network allowed"); });
  const read = await set.tools[2].execute("read", { snapshot: id, format: "json" }, undefined, undefined, context());
  const text = read.content.find(part => part.type === "text")!;
  assert.equal(text.type, "text");
  if (text.type === "text") {
    const payload = JSON.parse(JSON.parse(text.text).chunk);
    assert.deepEqual(payload.data.response, response);
    assert.doesNotMatch(text.text, /pi-web-codex-snapshot|test-account|Bearer/);
  }
  for (const format of ["html", "screenshot", "before-screenshot"] as const) await assert.rejects(set.tools[2].execute("unavailable", { snapshot: id, format }, undefined, undefined, context()), /unavailable/);
});

test("failed Codex producers preserve malformed response diagnostics and a readable snapshot ID", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-web-codex-error-"));
  isolateCredentials(t, directory);
  const set = createWebTools({ snapshots: new SnapshotStore({ directory: path.join(directory, "snapshots") }), settings: { backend: "auto" } });
  t.after(async () => { await set.close(); await rm(directory, { recursive: true, force: true }); });
  const response = { unexpected_output: "original diagnostic" };
  const transport = t.mock.method(globalThis, "fetch", async () => Response.json(response));
  let failure: unknown;
  try { await set.tools[0].execute("search", { query: "fixture" }, undefined, undefined, context()); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /missing output/);
  const id = failure.message.match(/snap_[a-f0-9]{32}/)?.[0];
  assert.ok(id);
  const saved = await set.snapshots.read(id, "json");
  const document = JSON.parse(JSON.parse(saved.text!).chunk);
  assert.equal(document.metadata.status, "error");
  assert.deepEqual(document.data.response, response);
  transport.mock.restore();
  let chunks = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('{"output":"partial evidence'));
      else controller.error(new Error("fixture stream failure"));
    },
  })));
  try { await set.tools[0].execute("partial", { query: "fixture" }, undefined, undefined, context()); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /fixture stream failure/);
  const partialId = failure.message.match(/snap_[a-f0-9]{32}/)?.[0];
  assert.ok(partialId);
  const partial = await set.snapshots.read(partialId, "json");
  assert.equal(JSON.parse(JSON.parse(partial.text!).chunk).data.response, '{"output":"partial evidence');
  assert.match(partial.warnings.join(" "), /incomplete/);
});
