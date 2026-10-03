import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "../src/broker/client.ts";
import { BrowserResearch } from "../src/web/browser.ts";
import { CODEX_ENDPOINT } from "../src/web/codex.ts";
import { createWebTools, isWebBackend, type WebBackend, type WebBackendState, type WebSettings } from "../src/web/index.ts";
import { fixtureClient, isolateBrokers } from "./helpers.ts";

// BrowserResearch.run is mocked in policy tests; the client is never used.
const unusedClient = fixtureClient(() => { throw new Error("No browser tab expected"); });

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
function context(auth: () => Promise<string | undefined> = async () => token): ExtensionToolContext {
  return { modelRegistry: { getApiKeyForProvider: auth }, model: undefined } as unknown as ExtensionToolContext;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const operations = [
  { index: 0, kind: "search", params: { query: "fixture query" } },
  { index: 1, kind: "fetch", params: { url: "https://example.test/article" } },
] as const;

test("backend state captures host/environment/default precedence and validates overrides without mutation", async t => {
  const previous = process.env.PI_WEB_BACKEND;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_BACKEND;
    else process.env.PI_WEB_BACKEND = previous;
  });
  for (const value of ["auto", "codex", "browser"]) assert.equal(isWebBackend(value), true);
  for (const value of [undefined, null, "", "AUTO", "typo", 1, {}, ["browser"]]) assert.equal(isWebBackend(value), false);

  for (const fixture of [
    { environment: undefined, host: undefined, configured: "browser", source: "default" },
    { environment: "browser", host: undefined, configured: "browser", source: "environment" },
    { environment: "browser", host: "codex", configured: "codex", source: "host" },
    { environment: "codex", host: "auto", configured: "auto", source: "host" },
  ] as const) {
    if (fixture.environment === undefined) delete process.env.PI_WEB_BACKEND;
    else process.env.PI_WEB_BACKEND = fixture.environment;
    const settings: Partial<WebSettings> = fixture.host ? { backend: fixture.host } : {};
    const set = createWebTools({ settings });
    t.after(() => set.close());
    const configured: WebBackendState = { configured: fixture.configured, override: null, effective: fixture.configured, source: fixture.source };
    assert.deepEqual(set.getBackendState(), configured);
    // Neither later caller configuration nor environment changes affect this tool set.
    settings.backend = "browser";
    process.env.PI_WEB_BACKEND = "auto";
    assert.deepEqual(set.getBackendState(), configured);
    for (const override of ["browser", "codex", "auto"] as const) {
      const environment: string | undefined = process.env.PI_WEB_BACKEND;
      set.setBackendOverride(override);
      const expected = { ...configured, override, effective: override, source: "override" };
      assert.deepEqual(set.getBackendState(), expected);
      assert.equal(process.env.PI_WEB_BACKEND, environment);
      const copy = set.getBackendState();
      copy.override = null;
      copy.configured = "browser";
      copy.effective = "browser";
      copy.source = "default";
      assert.deepEqual(set.getBackendState(), expected);
      for (const invalid of [undefined, "", "AUTO", "typo", 0, {}, ["browser"]]) {
        assert.throws(() => set.setBackendOverride(invalid as WebBackend), /backend override must be/);
        assert.deepEqual(set.getBackendState(), expected);
      }
      set.setBackendOverride(null);
      assert.deepEqual(set.getBackendState(), configured);
    }
    const closing = set.close();
    for (const value of [null, "browser", "codex", "auto"] as const) assert.throws(() => set.setBackendOverride(value), /Web tools closed/);
    assert.deepEqual(set.getBackendState(), configured);
    await closing;
    assert.throws(() => set.setBackendOverride(null), /Web tools closed/);
    await assert.rejects(set.tools[0]!.execute("closed", { query: "fixture" }, undefined, undefined, context()), /Web tools closed/);
  }
});

test("both web tools follow overrides without changing names, schemas, or actual-backend details", async t => {
  const set = createWebTools({ settings: { backend: "auto" }, browser: () => unusedClient });
  t.after(() => set.close());
  assert.deepEqual(set.tools.map(tool => tool.name), ["web_search", "web_fetch", "web_read"]);
  assert.deepEqual(Object.keys(set.tools[0]!.parameters.properties), ["query", "max_results"]);
  assert.deepEqual(Object.keys(set.tools[1]!.parameters.properties), ["url"]);
  let authCalls = 0;
  const ctx = context(async () => { authCalls++; return token; });
  const transport = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), CODEX_ENDPOINT);
    return Response.json({ output: "Mock Codex result" });
  });
  const browsers: BrowserResearch[] = [];
  const browser = t.mock.method(BrowserResearch.prototype, "run", async function (this: BrowserResearch, kind: "search" | "fetch", value: string) {
    browsers.push(this);
    return { output: `Faux browser ${kind}: ${value}`, url: "https://example.test/", title: "Fixture", tab: "fixture", limitations: [] };
  });
  const close = t.mock.method(BrowserResearch.prototype, "close", async () => {});
  for (const override of ["browser", "codex", "auto", "browser"] as const) {
    set.setBackendOverride(override);
    for (const operation of operations) {
      const before = { auth: authCalls, browser: browser.mock.callCount(), codex: transport.mock.callCount() };
      const result = await set.tools[operation.index]!.execute(operation.kind, operation.params, undefined, undefined, ctx);
      assert.equal(result.details.backend, override === "browser" ? "browser" : "codex");
      assert.equal(authCalls - before.auth, override === "browser" ? 0 : 1);
      assert.equal(transport.mock.callCount() - before.codex, override === "browser" ? 0 : 1);
      assert.equal(browser.mock.callCount() - before.browser, override === "browser" ? 1 : 0);
    }
  }
  assert.equal(new Set(browsers).size, 1, "switches retain the same research instance");
  assert.equal(close.mock.callCount(), 0);
});

test("each invocation snapshots auto before Codex auth or transport yields; subsequent calls use the new policy", async t => {
  t.mock.method(BrowserResearch.prototype, "run", async () => ({ output: "Faux fallback", url: "https://example.test/", title: "Fixture", tab: "fixture", limitations: [] }));
  for (const operation of operations) {
    for (const phase of ["auth", "request"] as const) {
      await t.test(`${operation.kind}: ${phase}`, async t => {
        const set = createWebTools({ settings: { backend: "auto" }, browser: () => unusedClient });
        t.after(() => set.close());
        const entered = deferred<void>();
        const release = deferred<void>();
        let firstAuth = true;
        const ctx = context(async () => {
          if (phase === "auth" && firstAuth) {
            firstAuth = false;
            entered.resolve();
            await release.promise;
          }
          return token;
        });
        let firstRequest = true;
        t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
          assert.equal(String(url), CODEX_ENDPOINT);
          if (phase === "request" && firstRequest) {
            firstRequest = false;
            entered.resolve();
            await release.promise;
          }
          return new Response("fixture unavailable", { status: 503 });
        });
        const pending = set.tools[operation.index]!.execute("pending", operation.params, undefined, undefined, ctx);
        // The auth callback runs synchronously; even an immediate switch must not alter fallback.
        if (phase === "request") await entered.promise;
        set.setBackendOverride("codex");
        release.resolve();
        const result = await pending;
        assert.equal(result.details.backend, "browser");
        assert.match(result.details.fallbackReason ?? "", /503/);
        await assert.rejects(set.tools[operation.index]!.execute("next", operation.params, undefined, undefined, ctx), /503/);
      });
    }
  }
});

test("a live local challenge and queued browser call survive browser → codex → browser without tab reset", { timeout: 45_000 }, async t => {
  await isolateBrokers(t);
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-backend-"));
  const client = new BrowserClient({ source: { browser: "firefox", profileDir: path.join(root, "profile"), headless: true }, session: "backend", idleMs: 300 });
  const waiting = deferred<void>();
  const continueAttention = deferred<boolean>();
  const corrected = deferred<void>();
  let solved = false;
  let navigations = 0;
  let attentionTab = "";
  const server = http.createServer((request, response) => {
    if (request.url === "/state") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(solved)); return; }
    if (request.url === "/corrected") { corrected.resolve(); response.end("ok"); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/challenge") {
      navigations++;
      response.end(`<!doctype html><title>Just a moment</title><main>Please verify you are human.</main><script>
        const original = crypto.randomUUID();
        sessionStorage.setItem('original', original);
        const timer = setInterval(async () => {
          if (!await (await fetch('/state')).json()) return;
          clearInterval(timer);
          document.title = 'Corrected local fixture';
          document.querySelector('main').textContent = 'Corrected live document with retained state: ' + original;
          await fetch('/corrected');
        }, 50);
      </script>`);
    } else response.end("<!doctype html><title>Queued fixture</title><main>Queued local browser document.</main>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === CODEX_ENDPOINT) return Response.json({ output: "Mock Codex result during browser attention" });
    assert.equal(new URL(String(url)).hostname, "127.0.0.1", "no public requests permitted");
    return nativeFetch(url, init);
  });
  const set = createWebTools({
    settings: { backend: "browser" }, browser: () => client,
    onAttention: async request => { attentionTab = request.tab; waiting.resolve(); return continueAttention.promise; },
  });
  t.after(async () => {
    continueAttention.resolve(false);
    await set.close();
    await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const fetchTool = set.tools[1]!;
  const pending = fetchTool.execute("challenge", { url: `${base}/challenge` }, undefined, undefined, context());
  void pending.catch(() => {});
  await waiting.promise;
  assert.equal(navigations, 1);
  set.setBackendOverride("codex");
  const codex = await fetchTool.execute("codex", { url: `${base}/challenge` }, undefined, undefined, context());
  assert.equal(codex.details.backend, "codex");
  assert.equal(navigations, 1);
  set.setBackendOverride("browser");
  let authCalls = 0;
  const queued = fetchTool.execute("queued", { url: `${base}/article` }, undefined, undefined, context(async () => { authCalls++; return token; }));
  void queued.catch(() => {});
  // The queued invocation must remain browser-only even if changed before its work starts.
  set.setBackendOverride("codex");
  solved = true;
  await corrected.promise;
  continueAttention.resolve(true);
  const resumed = await pending;
  assert.equal(resumed.details.backend, "browser");
  assert.equal(resumed.details.tab, attentionTab);
  assert.match(JSON.stringify(resumed.content), new RegExp(`Tab: ${attentionTab.replaceAll(".", "\\.").replaceAll("+", "\\+")}`));
  assert.match(JSON.stringify(resumed.content), /Corrected live document with retained state/);
  assert.equal(navigations, 1, "continuation inspects the existing document without navigation");
  const queuedResult = await queued;
  assert.equal(queuedResult.details.backend, "browser");
  assert.match(JSON.stringify(queuedResult.content), /Queued local browser document/);
  assert.equal(authCalls, 0);
  assert.equal(set.getBackendState().effective, "codex");
});
