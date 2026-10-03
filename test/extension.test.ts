import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, type JsonObject, type JsonValue } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { BrowserClient } from "../src/broker/client.ts";
import browserExtension from "../src/extension.ts";
import { CODEX_ENDPOINT } from "../src/web/codex.ts";
import { SnapshotStore, WebAttentionRequired } from "../src/web/index.ts";
import { copySnapshotTree } from "../src/snapshot-copy.ts";
import { brokerPids, fixtureServer, isolateBrokers, waitFor } from "./helpers.ts";

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotId(result: { details: JsonObject }): string {
  assert(typeof result.details.snapshot === "string");
  return result.details.snapshot;
}

/** Isolated agent directory and brokers; the latter are stopped after the test. */
async function environment(t: TestContext, settings: Record<string, string>) {
  const brokers = await isolateBrokers(t);
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-extension-"));
  const values = { PI_CODING_AGENT_DIR: root, PI_WEB_BACKEND: "codex", PI_BROWSER: "chromium", PI_BROWSER_HEADLESS: "true", ...settings };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { root, brokers };
}

async function sdk(root: string, confirm?: ExtensionUIContext["confirm"], options: Pick<CreateAgentSessionOptions, "sessionManager" | "sessionStartEvent"> = {}) {
  const fake = fauxProvider({ provider: "browser-test", api: "browser-test", models: [{ id: "local" }], tokenSize: { min: 100, max: 100 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(fake.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let started = false;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      browserExtension(pi);
      pi.on("session_start", () => { started = true; });
    }],
  });
  await loader.reload();
  assert.equal(started, false);
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const definitions = loaded.extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
  assert.deepEqual(definitions.map(tool => tool.name).sort(), ["browser", "web_fetch", "web_read", "web_search"], "all four tools exist before session_start and allowlist selection");
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: fake.getModel(),
    sessionManager: SessionManager.inMemory(root), settingsManager, resourceLoader: loader,
    tools: ["read", "browser", "web_search", "web_fetch", "web_read"], ...options,
  });
  const errors: string[] = [];
  await session.bindExtensions({ mode: confirm ? "rpc" : "print", onError: error => errors.push(error.error),
    ...(confirm ? { uiContext: { ...session.extensionRunner.getUIContext(), confirm } } : {}),
  });
  assert.equal(started, true);
  assert.deepEqual(session.agent.state.tools.map(tool => tool.name).sort(), ["browser", "read", "web_fetch", "web_read", "web_search"]);
  return {
    session, definitions, errors,
    snapshots: new SnapshotStore({ directory: path.join(root, "browser", session.sessionId, "snapshots") }),
    async run(name: string, args: JsonObject) {
      fake.setResponses([
        fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
        fauxAssistantMessage("Fixture complete."),
      ]);
      await session.prompt("Execute the scripted local fixture.");
      const result = session.messages.findLast(message => message.role === "toolResult");
      assert(result?.role === "toolResult");
      assert.equal(result.isError, false, JSON.stringify(result));
      return { ...result, details: isJsonObject(result.details) ? result.details : {} };
    },
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      assert.deepEqual(errors, []);
    },
  };
}

test("static registration is lazy, Codex-only never requests a browser, and shutdown rejects stale execution", async t => {
  const { root, brokers } = await environment(t, {});
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.test`;
  t.mock.method(ModelRegistry.prototype, "getApiKeyForProvider", async () => token);
  const transport = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), CODEX_ENDPOINT);
    return Response.json({ output: "[Fixture source](https://example.com/source)" });
  });
  const host = await sdk(root);
  try {
    assert.equal(transport.mock.callCount(), 0);
    await assert.rejects(stat(host.snapshots.directory), { code: "ENOENT" }, "registration and session_start leave storage lazy");
    for (const definition of host.definitions) {
      assert(!Check(definition.parameters, definition.name === "web_search" ? { query: "fixture", backend: "browser" } : { url: "https://example.com/", backend: "browser" }));
    }
    assert.equal((await host.run("web_search", { query: "fixture" })).details.backend, "codex");
    const fetched = await host.run("web_fetch", { url: "https://example.com/source" });
    assert.equal(fetched.details.backend, "codex");
    assert.match(JSON.stringify((await host.run("web_read", { snapshot: fetched.details.snapshot })).content), /Fixture source/);
    assert.equal(transport.mock.callCount(), 2, "web_read makes no transport request");
    assert.deepEqual(await readdir(path.join(root, "browser")), [host.session.sessionId], "Codex saves evidence but creates no browser profiles");
    assert.deepEqual(await readdir(path.join(root, "browser", host.session.sessionId)), ["snapshots"]);
    const context = host.session.extensionRunner.createToolContext("late", undefined);
    await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    const browser = host.definitions.find(tool => tool.name === "browser")!;
    await assert.rejects(async () => browser.execute("late", {}, undefined, undefined, context), /shut down/);
    assert.deepEqual(await brokerPids(brokers), [], "no browser broker was started");
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("snapshot evidence and cursors survive reload and fork without copying other session state", async t => {
  const { root } = await environment(t, {});
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.test`;
  t.mock.method(ModelRegistry.prototype, "getApiKeyForProvider", async () => token);
  const transport = t.mock.method(globalThis, "fetch", async () => Response.json({ output: `# Durable fixture\n${"Saved evidence. ".repeat(6000)}\nEnd of fixture.` }));
  const parent = await sdk(root, undefined, { sessionManager: SessionManager.create(root, path.join(root, "sessions")) });
  const hosts = [parent];
  t.after(async () => { for (const host of hosts) await host.close(); await rm(root, { recursive: true, force: true }); });
  const fetched = await parent.run("web_fetch", { url: "https://example.com/durable" });
  const snapshot = snapshotId(fetched);
  const firstPage = await parent.run("web_read", { snapshot });
  const cursor = firstPage.details.nextCursor;
  assert(typeof cursor === "string" && cursor);
  const previousFile = parent.session.sessionFile!;
  const originalSession = parent.session.sessionId;
  await parent.close();
  const reloaded = await sdk(root, undefined, { sessionManager: SessionManager.open(previousFile), sessionStartEvent: { type: "session_start", reason: "reload" } });
  hosts.push(reloaded);
  assert.equal(reloaded.session.sessionId, originalSession);
  const continuation = await reloaded.run("web_read", { snapshot, cursor });
  assert.match(JSON.stringify(continuation.content), /Saved evidence/);
  const parentBase = path.dirname(reloaded.snapshots.directory);
  for (const name of ["manual", "research"]) {
    await mkdir(path.join(parentBase, name), { mode: 0o700 });
    await writeFile(path.join(parentBase, name, "private-profile"), "cookie or browser owner state", { mode: 0o600 });
  }
  await reloaded.close();
  const child = await sdk(root, undefined, { sessionManager: SessionManager.forkFrom(previousFile, root, path.join(root, "sessions")),
    sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile: previousFile } });
  hosts.push(child);
  assert.notEqual(child.session.sessionId, originalSession);
  assert.deepEqual(await readdir(path.dirname(child.snapshots.directory)), ["snapshots"]);
  assert.deepEqual((await child.snapshots.info(snapshot)).available, fetched.details.available);
  await rm(reloaded.snapshots.directory, { recursive: true });
  const inherited = await child.run("web_read", { snapshot, cursor });
  assert.deepEqual(inherited.content, continuation.content, "fork retains cursor keys and has an independent evidence copy");
  const independent = await sdk(root);
  hosts.push(independent);
  await assert.rejects(independent.snapshots.info(snapshot), /expired|not present/);
  assert.equal(transport.mock.callCount(), 1);
});

test("failed snapshot fork blocks tools instead of silently starting an empty store", async t => {
  const { root } = await environment(t, {});
  const parent = SessionManager.create(root, path.join(root, "sessions"));
  parent.appendMessage(fauxAssistantMessage("Parent fixture."));
  const source = new SnapshotStore({ directory: path.join(root, "browser", parent.getSessionId(), "snapshots") });
  const saved = await source.save({ kind: "fetch", metadata: {}, md: "Locked evidence" });
  await mkdir(path.join(source.directory, ".operation-lock"), { mode: 0o700 });
  const previousSessionFile = parent.getSessionFile()!;
  const host = await sdk(root, undefined, { sessionManager: SessionManager.forkFrom(previousSessionFile, root, path.join(root, "sessions")),
    sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(host.errors.length, 1);
  assert.match(host.errors[0]!, /operation lock/);
  host.errors.length = 0;
  const read = host.definitions.find(tool => tool.name === "web_read")!;
  await assert.rejects(read.execute("locked", { snapshot: saved.id }, undefined, undefined, host.session.extensionRunner.createToolContext("locked", undefined)), /operation lock/);
  await assert.rejects(stat(host.snapshots.directory), { code: "ENOENT" });
});

test("snapshot copying excludes pending state and rejects links, active locks, and oversized evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-snapshot-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new SnapshotStore({ directory: path.join(root, "source") });
  const saved = await source.save({ kind: "fetch", metadata: {}, md: "Copied evidence" });
  await mkdir(path.join(source.directory, ".pending-unused"), { mode: 0o700 });
  await mkdir(path.join(source.directory, "profile"), { mode: 0o700 });
  const destination = path.join(root, "destination");
  await copySnapshotTree(source.directory, destination);
  assert.deepEqual(await readdir(destination), [saved.id]);
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(destination, saved.id, "content.md"))).mode & 0o777, 0o600);
  assert.equal((await new SnapshotStore({ directory: destination }).read(saved.id)).text, "Copied evidence");
  await assert.rejects(copySnapshotTree(source.directory, destination), { code: "EEXIST" });
  const absent = path.join(root, "absent");
  await copySnapshotTree(path.join(root, "missing"), absent);
  await assert.rejects(stat(absent), { code: "ENOENT" });
  const lock = path.join(source.directory, ".operation-lock");
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(copySnapshotTree(source.directory, absent), /operation lock/);
  await rm(lock, { recursive: true });
  const alias = path.join(root, "alias");
  await symlink(source.directory, alias);
  await assert.rejects(copySnapshotTree(alias, absent), /without symlinks/);
  const artifact = saved.paths.md!;
  await rm(artifact);
  await symlink(path.join(destination, saved.id, "content.md"), artifact);
  await assert.rejects(copySnapshotTree(source.directory, absent), { code: "ELOOP" });
  await assert.rejects(stat(absent), { code: "ENOENT" });
  await rm(artifact);
  const oversized = await open(artifact, "wx", 0o600);
  try { await oversized.truncate(5 * 1024 * 1024); } finally { await oversized.close(); }
  await assert.rejects(copySnapshotTree(source.directory, absent), /byte limit/);
  await rm(artifact);
  await writeFile(artifact, "Copied evidence", { mode: 0o600 });
  await chmod(artifact, 0o644);
  await assert.rejects(copySnapshotTree(source.directory, absent), /private regular files/);
  await assert.rejects(stat(lock), { code: "ENOENT" }, "failed copies release their own source lock");
});

/** A later client sees the tabs Pi sessions left behind; disconnected sessions' tabs close. */
async function remainingTabs(root: string, browser: "chromium" | "firefox") {
  const check = new BrowserClient({ source: { browser, profileDir: path.join(root, "browser", "profiles", browser), headless: true }, session: "check" });
  try { return await check.list(); } finally { await check.close(); }
}

test("/browser selects the browser shared by browser and web tools; each browser keeps its tabs and cookies", { timeout: 120_000 }, async t => {
  const { root, brokers } = await environment(t, { PI_WEB_BACKEND: "browser", PI_BROWSER: "chromium" });
  let solved = false;
  let corrected!: () => void;
  const correction = new Promise<void>(resolve => { corrected = resolve; });
  let attentionNavigations = 0;
  const origin = await fixtureServer(t, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/state") { response.end(String(solved)); return; }
    if (request.url === "/corrected") { corrected(); response.end("ok"); return; }
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/attention") {
      attentionNavigations++;
      response.end(`<!doctype html><title>Fixture</title><main>Please verify you are human.</main><script>
        const original = crypto.randomUUID();
        const timer = setInterval(async () => { if (await (await fetch('/state')).text() === 'true') {
          clearInterval(timer); document.querySelector('main').textContent = 'Retained research document: ' + original;
          await fetch('/corrected');
        } }, 20);
      </script>`);
    } else {
      if (request.url === "/seed") response.setHeader("Set-Cookie", "research=firefox; Path=/; SameSite=Lax");
      response.end(`<!doctype html><title>Local article ${request.url}</title><main><h1>Local article</h1><p>Cookie: ${request.headers.cookie ?? "none"}</p></main>`);
    }
  });
  const host = await sdk(root);
  t.after(() => host.close());
  await host.session.prompt("/browser firefox");
  await host.session.prompt("/browser status");
  assert.deepEqual(await brokerPids(brokers), [], "selecting and reporting a browser starts nothing");
  const firefox = await host.run("browser", { url: origin,
    eval: "document.querySelector('main').textContent = 'Retained manual edit'; document.title = 'Edited Firefox'; document.title" });
  assert.equal(firefox.details.browser, "firefox");
  const seeded = await host.run("web_fetch", { url: `${origin}/seed` });
  assert(typeof seeded.details.tab === "string");
  assert.match(JSON.stringify(seeded.content), new RegExp(`Tab: ${seeded.details.tab.replaceAll(".", "\\.").replace("+", "\\+")}`));
  const inspected = await host.run("browser", { tab: seeded.details.tab, eval: "document.cookie" });
  assert.equal(inspected.details.eval_result, "research=firefox", "research tabs live in the same browser as the browser tool");
  const fetchTool = host.definitions.find(tool => tool.name === "web_fetch")!;
  let pendingTab = "";
  await assert.rejects(fetchTool.execute("attention", { url: `${origin}/attention` }, undefined, undefined,
    host.session.extensionRunner.createToolContext("attention", undefined)), error => {
    assert(error instanceof WebAttentionRequired);
    pendingTab = error.tab;
    return true;
  });
  assert.equal(attentionNavigations, 1);

  await host.session.prompt("/browser chromium");
  const chromiumResearch = await host.run("web_fetch", { url: `${origin}/cookies` });
  assert.match(JSON.stringify(chromiumResearch.content), /Cookie: none/, "browsers have separate profiles");
  const followUp = await host.run("browser", { eval: "document.title" });
  assert.deepEqual([followUp.details.browser, followUp.details.tab, followUp.details.eval_result],
    ["chromium", chromiumResearch.details.tab, "Local article /cookies"], "the last research tab is this session's default tab");
  assert.equal((await brokerPids(brokers)).length, 2);

  await host.session.prompt("/browser firefox");
  const retained = await host.run("browser", { tab: firefox.details.tab as string, eval: "document.querySelector('main').textContent" });
  assert.deepEqual([retained.details.title, retained.details.eval_result], ["Edited Firefox", "Retained manual edit"]);
  const firefoxResearch = await host.run("web_fetch", { url: `${origin}/cookies` });
  assert.match(JSON.stringify(firefoxResearch.content), /Cookie: research=firefox/);
  solved = true;
  await correction;
  const resumed = await host.run("web_fetch", { url: `${origin}/attention` });
  assert.equal(resumed.details.tab, pendingTab, "switching back resumes the original pending tab");
  assert.match(JSON.stringify(resumed.content), /Retained research document/);
  assert.equal(attentionNavigations, 1, "retry does not navigate over retained research state");
  await host.session.prompt("/browser reset");
  await host.session.prompt("/browser status");
  assert.equal((await brokerPids(brokers)).length, 2, "switching and reset start no further browsers");
  for (const browser of ["firefox", "chromium"]) {
    const owner = JSON.parse(await readFile(path.join(root, "browser", "profiles", browser, ".pi-browser-owner", "owner.json"), "utf8"));
    assert((await brokerPids(brokers)).includes(owner.pid), "each stable profile is held by its broker");
  }
  await host.close();
  for (const browser of ["firefox", "chromium"] as const) {
    await waitFor(async () => (await remainingTabs(root, browser)).length === 0, 10_000, `${browser} tabs to close after shutdown`);
  }
});

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser}: two Pi sessions share one browser and its tabs; evidence and attention stay per session`, { timeout: 120_000 }, async t => {
    const { root, brokers } = await environment(t, { PI_WEB_BACKEND: "browser", PI_BROWSER: browser });
    let solved = false;
    let attentionNavigations = 0;
    const origin = await fixtureServer(t, (request, response) => {
      if (request.url === "/state") { response.end(String(solved)); return; }
      response.setHeader("Content-Type", "text/html");
      if (request.url === "/attention") {
        attentionNavigations++;
        response.end(`<!doctype html><title>Fixture</title><main>Please verify you are human.</main><script>
          const timer = setInterval(async () => { if (await (await fetch('/state')).text() === 'true') {
            clearInterval(timer); document.querySelector('main').innerHTML = '<h1>Resolved fixture</h1><p>Human supplied readable article content.</p>';
          } }, 20);
        </script>`);
      } else response.end("<!doctype html><title>Local article</title><main><h1>Local article</h1><p>Readable local fixture content for research.</p></main>");
    });
    let confirmations = 0;
    const first = await sdk(root, async (title, message, options) => {
      confirmations++;
      assert.equal(title, "Web browser needs attention");
      assert.match(message, /human verification/);
      assert.match(message, /Tab:/);
      assert.match(message, /continue without reloading/);
      assert(options?.signal instanceof AbortSignal);
      solved = true;
      await delay(200);
      return true;
    });
    const second = await sdk(root);
    t.after(() => Promise.all([first.close(), second.close()]));
    const firstManual = await first.run("browser", { url: origin, eval: "document.cookie = 'owner=first;path=/'; document.title = 'Manual edit'; document.title" });
    const name = firstManual.details.tab as string;
    assert.equal(firstManual.details.browser, browser);
    const secondManual = await second.run("browser", { url: origin, eval: "document.cookie" });
    assert.equal(secondManual.details.eval_result, "owner=first", "sessions share one stable profile");
    assert.equal(secondManual.details.tab, `${name}-2`, "a new session gets its own automatically named tab");
    assert.equal((await brokerPids(brokers)).length, 1, "both sessions use one broker and browser");
    const listed = await second.run("browser", { list: true });
    assert.match(JSON.stringify(listed.content), new RegExp(`${name.replaceAll(".", "\\.").replace("+", "\\+")} — Manual edit — .* — last used by ${first.session.sessionId}`));
    assert.equal((await second.run("browser", { tab: name, eval: "document.title" })).details.eval_result, "Manual edit");
    assert.match(JSON.stringify((await first.run("browser", { eval: "document.title" })).content), new RegExp(`Warning: Tab .* was used by session ${second.session.sessionId}`));
    assert(!JSON.stringify(firstManual.content).includes(root));
    const manualEvidence = await first.snapshots.info(snapshotId(firstManual));
    const otherEvidence = await second.snapshots.info(snapshotId(secondManual));
    assert.notEqual(path.dirname(manualEvidence.paths.html!), path.dirname(otherEvidence.paths.html!));
    await assert.rejects(second.snapshots.info(snapshotId(firstManual)), /expired|not present/, "evidence stays per session");
    const html = await first.run("web_read", { snapshot: firstManual.details.snapshot, format: "html" });
    assert.match(JSON.stringify(html.content), /Manual edit/);
    for (const format of ["screenshot", "before-screenshot"]) {
      const image = await first.run("web_read", { snapshot: firstManual.details.snapshot, format });
      assert(image.content.some(block => block.type === "image" && block.mimeType === "image/png"));
    }
    assert.match(JSON.stringify((await first.run("read", { path: manualEvidence.paths.html! })).content), /Manual edit/);
    const noUIFetch = second.definitions.find(tool => tool.name === "web_fetch")!;
    await assert.rejects(noUIFetch.execute("no-ui", { url: `${origin}/attention` }, undefined, undefined,
      second.session.extensionRunner.createToolContext("no-ui", undefined)), WebAttentionRequired);
    const attention = await first.run("web_fetch", { url: `${origin}/attention` });
    assert.equal(attention.details.backend, "browser");
    assert.match(JSON.stringify(attention.content), /Human supplied readable article/);
    assert.match(JSON.stringify((await first.run("web_read", { snapshot: attention.details.snapshot })).content), /Human supplied readable article/);
    assert.equal(confirmations, 1);
    assert.equal(attentionNavigations, 2, "each session navigates once; Continue never repeats navigation");
    await second.run("web_fetch", { url: `${origin}/attention` });
    assert.equal(attentionNavigations, 2, "a no-UI retry also resumes its retained page");
    assert.equal((await first.run("browser", { tab: name, eval: "document.title" })).details.eval_result, "Manual edit", "research never navigates browser-tool tabs");
    await Promise.all([first.close(), second.close()]);
    await waitFor(async () => (await remainingTabs(root, browser)).length === 0, 10_000, "tabs to close after both sessions shut down");
    assert.match(await readFile(manualEvidence.paths.html!, "utf8"), /Manual edit/);
    assert.equal((await first.snapshots.read(snapshotId(firstManual), "screenshot")).image?.mimeType, "image/png", "shutdown preserves evidence");
  });
}
