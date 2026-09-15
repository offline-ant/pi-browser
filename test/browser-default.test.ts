import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBrowserDefault, isBrowserKind, type BrowserDefaultState } from "../src/browser-default.ts";
import { createBrowserTool } from "../src/browser-tool.ts";
import { BrowserProcessLauncher, type BrowserKind } from "../src/core/index.ts";
import { BrowserResearch } from "../src/web/browser.ts";
import { createWebTools } from "../src/web/index.ts";

const root = path.join(tmpdir(), "pi-browser-default-unit");
const context = {} as ExtensionContext;
const result = { output: "Mock research", url: "https://example.test/", title: "Fixture", tabId: "fixture", limitations: [] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("browser defaults validate, snapshot configured precedence, and return independent state copies", () => {
  for (const value of ["chromium", "firefox"]) assert.equal(isBrowserKind(value), true);
  for (const value of [undefined, null, "", "Firefox", "auto", 1, {}, ["firefox"]]) assert.equal(isBrowserKind(value), false);
  for (const fixture of [
    { environment: undefined, host: undefined, configured: "chromium", source: "default" },
    { environment: "firefox", host: undefined, configured: "firefox", source: "environment" },
    { environment: "firefox", host: "chromium", configured: "chromium", source: "host" },
    { environment: "chromium", host: "firefox", configured: "firefox", source: "host" },
  ] as const) {
    const environment: NodeJS.ProcessEnv = fixture.environment ? { PI_WEB_BROWSER: fixture.environment } : {};
    const options: { browser?: BrowserKind } = { browser: fixture.host };
    const defaults = createBrowserDefault(options, environment);
    const configured: BrowserDefaultState = { configured: fixture.configured, override: null, effective: fixture.configured, source: fixture.source };
    assert.deepEqual(defaults.getState(), configured);
    options.browser = "firefox";
    environment.PI_WEB_BROWSER = "chromium";
    assert.deepEqual(defaults.getState(), configured, "configuration is captured at construction");
    for (const override of ["firefox", "chromium"] as const) {
      defaults.setOverride(override);
      const expected = { ...configured, override, effective: override, source: "override" };
      assert.deepEqual(defaults.getState(), expected);
      const copy = defaults.getState();
      copy.configured = "firefox";
      copy.override = null;
      copy.effective = "chromium";
      copy.source = "default";
      assert.deepEqual(defaults.getState(), expected);
      for (const invalid of [undefined, "", "Firefox", "auto", 0, {}, ["firefox"]]) {
        assert.throws(() => defaults.setOverride(invalid as BrowserKind), /Browser default override must be/);
        assert.deepEqual(defaults.getState(), expected);
      }
      defaults.setOverride(null);
      assert.deepEqual(defaults.getState(), configured);
    }
    assert.equal(environment.PI_WEB_BROWSER, "chromium", "overrides never mutate the environment");
  }
  assert.throws(() => createBrowserDefault({}, { PI_WEB_BROWSER: "invalid" }), /must be chromium \| firefox/);
  assert.throws(() => createBrowserDefault({ browser: "invalid" as BrowserKind }, {}), /must be chromium \| firefox/);
});

test("web and manual tools share browser policy while backend selection stays independent", async t => {
  const defaults = createBrowserDefault({ browser: "chromium" }, {});
  const web = createWebTools({ browserDefault: defaults, settings: { backend: "browser", browser: "chromium" } });
  const manual = createBrowserTool({ browserDefault: defaults, profileDir: root, artifactDir: root });
  t.after(async () => { await Promise.all([web.close(), manual.close()]); });
  const tools = web.tools;
  manual.setBrowserOverride("firefox");
  assert.deepEqual(web.getBrowserState(), manual.getBrowserState());
  assert.equal(web.getBrowserState().effective, "firefox");
  web.setBackendOverride("codex");
  assert.equal(manual.getBrowserState().effective, "firefox");
  web.setBrowserOverride("chromium");
  assert.equal(manual.getBrowserState().effective, "chromium");
  assert.equal(web.getBackendState().effective, "codex");
  manual.setBrowserOverride(null);
  assert.equal(web.getBrowserState().source, "host");
  assert.equal(web.tools, tools, "changing policy retains tool definitions");
  await web.close();
  assert.throws(() => web.setBrowserOverride("firefox"), /Web tools closed/);
  assert.throws(() => web.setBrowserOverride(null), /Web tools closed/);
  manual.setBrowserOverride("firefox");
  assert.equal(manual.getBrowserState().effective, "firefox", "closing one consumer does not close shared policy");
  await manual.close();
  assert.throws(() => manual.setBrowserOverride("chromium"), /Browser tools closed/);
  assert.throws(() => manual.setBrowserOverride(null), /Browser tools closed/);
});

test("both web tools select engines lazily and switching back retains research instances", async t => {
  const instances: BrowserResearch[] = [];
  t.mock.method(BrowserResearch.prototype, "run", async function (this: BrowserResearch) {
    instances.push(this);
    return result;
  });
  const closed: BrowserResearch[] = [];
  t.mock.method(BrowserResearch.prototype, "close", async function (this: BrowserResearch) { closed.push(this); });
  const web = createWebTools({ settings: { backend: "browser", browser: "chromium" } });
  t.after(() => web.close());
  assert.equal(instances.length, 0);
  for (const engine of ["chromium", "firefox", "chromium"] as const) {
    web.setBrowserOverride(engine);
    for (const operation of [{ index: 0, params: { query: "fixture" } }, { index: 1, params: { url: "https://example.test/" } }]) {
      const output = await web.tools[operation.index]!.execute("fixture", operation.params, undefined, undefined, context);
      assert.equal(output.details.backend, "browser");
      assert.equal(output.details.browser, engine);
      assert.match(JSON.stringify(output.content), new RegExp(`Backend: browser \\(${engine}\\)`));
    }
    assert.equal(closed.length, 0, "changing defaults must not close research");
  }
  assert.equal(instances[0], instances[1]);
  assert.equal(instances[2], instances[3]);
  assert.notEqual(instances[0], instances[2]);
  assert.equal(instances[0], instances[4], "switching back resumes the original engine owner");
  assert.equal(instances[0], instances[5]);
  await web.close();
  assert.deepEqual(new Set(closed), new Set(instances));
  assert.equal(closed.length, 2);
});

test("web engine is snapshotted before Codex authentication yields, including later fallback", async t => {
  t.mock.method(BrowserResearch.prototype, "run", async () => result);
  const transport = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network request permitted"); });
  for (const operation of [{ index: 0, params: { query: "fixture" } }, { index: 1, params: { url: "https://example.test/" } }]) {
    const entered = deferred();
    const release = deferred();
    const web = createWebTools({ settings: { backend: "auto", browser: "chromium" } });
    t.after(() => web.close());
    let calls = 0;
    const ctx = { modelRegistry: { getApiKeyForProvider: async () => {
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return undefined;
    } } } as unknown as ExtensionContext;
    const pending = web.tools[operation.index]!.execute("pending", operation.params, undefined, undefined, ctx);
    await entered.promise;
    web.setBrowserOverride("firefox");
    release.resolve();
    const first = await pending;
    assert.equal(first.details.browser, "chromium");
    assert.match(first.details.fallbackReason ?? "", /No OpenAI Codex OAuth token/);
    const next = await web.tools[operation.index]!.execute("next", operation.params, undefined, undefined, ctx);
    assert.equal(next.details.browser, "firefox");
  }
  assert.equal(transport.mock.callCount(), 0);
});

test("manual calls snapshot their queued default; explicit engines win and executables stay engine-specific", async t => {
  const entered = deferred();
  const release = deferred();
  const requests: Parameters<typeof BrowserProcessLauncher.create>[0][] = [];
  t.mock.method(BrowserProcessLauncher, "create", async (options: Parameters<typeof BrowserProcessLauncher.create>[0]) => {
    requests.push(options);
    if (requests.length === 1) { entered.resolve(); await release.promise; }
    throw new Error("fixture launch failure");
  });
  const manual = createBrowserTool({ profileDir: root, artifactDir: root, browser: "chromium", executable: "/fixture/chromium", headless: true });
  t.after(async () => { release.resolve(); await manual.close(); });
  const first = assert.rejects(manual.tool.execute("first", {}, undefined, undefined, context), /fixture launch failure/);
  await entered.promise;
  manual.setBrowserOverride("firefox");
  const queued = assert.rejects(manual.tool.execute("queued", {}, undefined, undefined, context), /fixture launch failure/);
  manual.setBrowserOverride("chromium");
  assert.equal(requests.length, 1);
  release.resolve();
  await Promise.all([first, queued]);
  await assert.rejects(manual.tool.execute("explicit", { browser: "firefox" }, undefined, undefined, context), /fixture launch failure/);
  await assert.rejects(manual.tool.execute("next", {}, undefined, undefined, context), /fixture launch failure/);
  assert.deepEqual(requests.map(request => [request.browser, request.executable]), [
    ["chromium", "/fixture/chromium"], ["firefox", undefined], ["firefox", undefined], ["chromium", "/fixture/chromium"],
  ]);
  for (const request of requests) assert.equal(request.profileDir, path.join(root, "default", request.browser!));
});

test("web research launches the selected engine and applies executable overrides only to the configured engine", async t => {
  const requests: Parameters<typeof BrowserProcessLauncher.create>[0][] = [];
  t.mock.method(BrowserProcessLauncher, "create", async (options: Parameters<typeof BrowserProcessLauncher.create>[0]) => { requests.push(options); throw new Error("fixture launch failure"); });
  const web = createWebTools({ settings: { backend: "browser", browser: "chromium", profileDir: root, executable: "/fixture/chromium", headless: true } });
  t.after(() => web.close());
  for (const browser of ["chromium", "firefox", "chromium"] as const) {
    web.setBrowserOverride(browser);
    await assert.rejects(web.tools[1]!.execute("fetch", { url: "https://example.test/" }, undefined, undefined, context), /fixture launch failure/);
  }
  assert.deepEqual(requests.map(request => [request.browser, request.executable]), [
    ["chromium", "/fixture/chromium"], ["firefox", undefined], ["chromium", "/fixture/chromium"],
  ]);
  for (const request of requests) assert.equal(request.profileDir, path.join(root, request.browser!));
});

test("web shutdown attempts every research owner even when one close fails", async t => {
  const owners: BrowserResearch[] = [];
  t.mock.method(BrowserResearch.prototype, "run", async function (this: BrowserResearch) { owners.push(this); return result; });
  const closed: BrowserResearch[] = [];
  t.mock.method(BrowserResearch.prototype, "close", async function (this: BrowserResearch) {
    closed.push(this);
    if (this === owners[0]) throw new Error("fixture cleanup failure");
  });
  const web = createWebTools({ settings: { backend: "browser", browser: "chromium" } });
  for (const browser of ["chromium", "firefox"] as const) {
    web.setBrowserOverride(browser);
    await web.tools[1]!.execute("fetch", { url: "https://example.test/" }, undefined, undefined, context);
  }
  const closing = web.close();
  assert.equal(web.close(), closing, "shutdown remains idempotent after failure");
  await assert.rejects(closing, error => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(String(error.errors[0]), /fixture cleanup failure/);
    return true;
  });
  assert.deepEqual(new Set(closed), new Set(owners));
  assert.equal(closed.length, 2);
  assert.throws(() => web.setBrowserOverride("chromium"), /Web tools closed/);
});
