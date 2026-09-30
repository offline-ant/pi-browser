import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
import browserExtension from "../src/extension.ts";
import { BrowserProcessLauncher } from "../src/core/index.ts";
import { CODEX_ENDPOINT } from "../src/web/codex.ts";
import { SnapshotStore, WebAttentionRequired } from "../src/web/index.ts";
import { copySnapshotTree } from "../src/snapshot-copy.ts";

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotId(result: { details: JsonObject }): string {
  assert(typeof result.details.snapshot === "string");
  return result.details.snapshot;
}

async function environment(t: TestContext, settings: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-extension-"));
  const values = { PI_CODING_AGENT_DIR: root, PI_WEB_PROFILE_DIR: undefined, PI_BROWSER_EXECUTABLE: undefined,
    PI_WEB_BACKEND: "codex", PI_WEB_BROWSER: "chromium", PI_BROWSER_HEADLESS: "true", ...settings };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return root;
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
  const root = await environment(t, {});
  const launches = t.mock.method(BrowserProcessLauncher, "create", async () => { throw new Error("No browser launch is permitted"); });
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.test`;
  t.mock.method(ModelRegistry.prototype, "getApiKeyForProvider", async () => token);
  const transport = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), CODEX_ENDPOINT);
    return Response.json({ output: "[Fixture source](https://example.com/source)" });
  });
  const host = await sdk(root);
  try {
    assert.equal(launches.mock.callCount(), 0);
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
    assert.equal(launches.mock.callCount(), 0);
    assert.deepEqual(await readdir(path.join(root, "browser", host.session.sessionId)), ["snapshots"], "Codex saves evidence but creates no browser profiles");
    const context = host.session.extensionRunner.createToolContext("late", undefined);
    await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    const browser = host.definitions.find(tool => tool.name === "browser")!;
    await assert.rejects(async () => browser.execute("late", {}, undefined, undefined, context), /shut down/);
    assert.equal(launches.mock.callCount(), 0);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("snapshot evidence and cursors survive reload and fork without copying profiles", async t => {
  const root = await environment(t, {});
  const launches = t.mock.method(BrowserProcessLauncher, "create", async () => { throw new Error("No browser launch is permitted"); });
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
  assert.equal(launches.mock.callCount(), 0);
});

test("failed snapshot fork blocks tools instead of silently starting an empty store", async t => {
  const root = await environment(t, {});
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

test("browser-default retains the destination engine and engine-specific research", { timeout: 90_000 }, async t => {
  const root = await environment(t, { PI_WEB_BACKEND: "browser", PI_WEB_BROWSER: "chromium" });
  let solved = false;
  let corrected!: () => void;
  const correction = new Promise<void>(resolve => { corrected = resolve; });
  let attentionNavigations = 0;
  const server = createServer((request, response) => {
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
      response.end(`<!doctype html><title>Local article</title><main><h1>Local article</h1><p>Cookie: ${request.headers.cookie ?? "none"}</p></main>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const launches = t.mock.method(BrowserProcessLauncher, "create", BrowserProcessLauncher.create);
  const host = await sdk(root);
  t.after(async () => {
    await host.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await host.session.prompt("/browser-default firefox");
  await host.session.prompt("/browser-default status");
  assert.equal(launches.mock.callCount(), 0, "selecting and reporting an engine starts no browser");
  const firefox = await host.run("browser", { url: origin,
    eval: "document.querySelector('main').textContent = 'Retained manual edit'; document.title = 'Edited Firefox'; document.title" });
  assert.equal(firefox.details.browser, "firefox");
  assert.equal((await host.run("web_fetch", { url: `${origin}/seed` })).details.browser, "firefox");
  const fetchTool = host.definitions.find(tool => tool.name === "web_fetch")!;
  let pendingTab = "";
  await assert.rejects(fetchTool.execute("attention", { url: `${origin}/attention` }, undefined, undefined,
    host.session.extensionRunner.createToolContext("attention", undefined)), error => {
    assert(error instanceof WebAttentionRequired);
    pendingTab = error.tabId;
    return true;
  });
  assert.equal(attentionNavigations, 1);

  await host.session.prompt("/browser-default chromium");
  const chromiumResearch = await host.run("web_fetch", { url: `${origin}/cookies` });
  assert.equal(chromiumResearch.details.browser, "chromium");
  assert.match(JSON.stringify(chromiumResearch.content), /Cookie: none/, "engines have separate research cookies");
  const retained = await host.run("browser", { eval: "document.querySelector('main').textContent" });
  assert.equal(retained.details.browser, "firefox");
  assert.equal(retained.details.tab_id, firefox.details.tab_id);
  assert.equal(retained.details.title, "Edited Firefox");
  assert.equal(retained.details.eval_result, "Retained manual edit");
  await host.session.prompt("/browser-close");
  const explicit = await host.run("browser", { browser: "firefox", url: origin });
  assert.equal(explicit.details.browser, "firefox", "explicit engine overrides the default after closing");
  await host.session.prompt("/browser-close");
  const chromium = await host.run("browser", { url: origin });
  assert.equal(chromium.details.browser, "chromium", "reopening uses the current default");

  const beforeCommands = launches.mock.callCount();
  await host.session.prompt("/browser-default firefox");
  const firefoxResearch = await host.run("web_fetch", { url: `${origin}/cookies` });
  assert.equal(firefoxResearch.details.browser, "firefox");
  assert.match(JSON.stringify(firefoxResearch.content), /Cookie: research=firefox/);
  solved = true;
  await correction;
  const resumed = await host.run("web_fetch", { url: `${origin}/attention` });
  assert.equal(resumed.details.tabId, pendingTab, "switching back resumes the original pending tab");
  assert.match(JSON.stringify(resumed.content), /Retained research document/);
  assert.equal(attentionNavigations, 1, "retry does not navigate over retained research state");
  await host.session.prompt("/browser-default reset");
  await host.session.prompt("/browser-default status");
  assert.equal(launches.mock.callCount(), beforeCommands, "switch-back, reset and status do not launch replacement browsers");

  const base = path.join(root, "browser", host.session.sessionId);
  const owners: { file: string; browserPid: number }[] = [];
  for (const profile of ["manual/chromium", "research/firefox", "research/chromium"]) {
    const file = path.join(base, profile, ".pi-browser-owner", "owner.json");
    const owner = JSON.parse(await readFile(file, "utf8"));
    assert.equal(owner.pid, process.pid);
    owners.push({ file, browserPid: owner.browserPid });
  }
  assert.equal(new Set(owners.map(owner => owner.browserPid)).size, 3);
  await host.close();
  for (const owner of owners) {
    await assert.rejects(stat(owner.file), { code: "ENOENT" });
    assert.throws(() => process.kill(owner.browserPid, 0), { code: "ESRCH" });
  }
});

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser}: faux SDK uses isolated manual/research profiles, attention UI and shutdown cleanup`, { timeout: 90_000 }, async t => {
    const root = await environment(t, { PI_WEB_BACKEND: "browser", PI_WEB_BROWSER: browser });
    let solved = false;
    let attentionNavigations = 0;
    const server = createServer((request, response) => {
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
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
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
    t.after(async () => {
      await Promise.all([first.close(), second.close()]);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    const launches = t.mock.method(BrowserProcessLauncher, "create", BrowserProcessLauncher.create);
    const firstManual = await first.run("browser", { url: origin, eval: "document.cookie = 'owner=first;path=/'; document.title = 'Manual edit'; document.title" });
    const secondManual = await second.run("browser", { url: origin, eval: "document.cookie" });
    assert.equal(secondManual.details.eval_result, "", "different Pi sessions do not share cookies");
    assert.notEqual(firstManual.details.snapshot, secondManual.details.snapshot);
    assert.equal(firstManual.details.browser, browser);
    assert(!("after_html" in firstManual.details));
    assert(!("before_screenshot" in firstManual.details));
    assert(!JSON.stringify(firstManual.content).includes(root));
    const manualEvidence = await first.snapshots.info(snapshotId(firstManual));
    const otherEvidence = await second.snapshots.info(snapshotId(secondManual));
    assert.notEqual(path.dirname(manualEvidence.paths.html!), path.dirname(otherEvidence.paths.html!));
    const readOnlyLaunches = launches.mock.callCount();
    const html = await first.run("web_read", { snapshot: firstManual.details.snapshot, format: "html" });
    assert.match(JSON.stringify(html.content), /Manual edit/);
    for (const format of ["screenshot", "before-screenshot"]) {
      const image = await first.run("web_read", { snapshot: firstManual.details.snapshot, format });
      assert(image.content.some(block => block.type === "image" && block.mimeType === "image/png"));
    }
    assert.match(JSON.stringify((await first.run("read", { path: manualEvidence.paths.html! })).content), /Manual edit/);
    assert((await first.run("read", { path: manualEvidence.paths.screenshot! })).content.some(block => block.type === "image"));
    assert.equal(launches.mock.callCount(), readOnlyLaunches, "saved HTML/image reads never launch another browser");
    const noUIFetch = second.definitions.find(tool => tool.name === "web_fetch")!;
    await assert.rejects(noUIFetch.execute("no-ui", { url: `${origin}/attention` }, undefined, undefined,
      second.session.extensionRunner.createToolContext("no-ui", undefined)), WebAttentionRequired);
    const attention = await first.run("web_fetch", { url: `${origin}/attention` });
    assert.equal(attention.details.backend, "browser");
    assert.match(JSON.stringify(attention.content), /Human supplied readable article/);
    const fetchedLaunches = launches.mock.callCount();
    assert.match(JSON.stringify((await first.run("web_read", { snapshot: attention.details.snapshot })).content), /Human supplied readable article/);
    assert((await first.run("web_read", { snapshot: attention.details.snapshot, format: "screenshot" })).content.some(block => block.type === "image"));
    assert.equal(launches.mock.callCount(), fetchedLaunches, "fetch-to-read uses saved evidence");
    assert.equal(confirmations, 1);
    assert.equal(attentionNavigations, 2, "each session navigates once; Continue never repeats navigation");
    await second.run("web_fetch", { url: `${origin}/attention` });
    assert.equal(attentionNavigations, 2, "a no-UI retry also resumes its retained page");
    assert.equal((await first.run("browser", { eval: "document.title" })).details.eval_result, "Manual edit", "research never navigates the manual browser");
    const owners: { file: string; browserPid: number }[] = [];
    for (const host of [first, second]) {
      const base = path.join(root, "browser", host.session.sessionId);
      for (const profile of [path.join(base, "manual", browser), path.join(base, "research", browser)]) {
        const file = path.join(profile, ".pi-browser-owner", "owner.json");
        const owner = JSON.parse(await readFile(file, "utf8"));
        assert.equal(owner.pid, process.pid);
        owners.push({ file, browserPid: owner.browserPid });
      }
    }
    assert.equal(new Set(owners.map(owner => owner.browserPid)).size, 4, "manual/research and Pi sessions have distinct processes");
    await first.session.prompt("/browser-close");
    await assert.rejects(stat(owners[0]!.file), { code: "ENOENT" });
    await stat(owners[1]!.file); // Manual close does not close research.
    await Promise.all([first.close(), second.close()]);
    for (const owner of owners) {
      await assert.rejects(stat(owner.file), { code: "ENOENT" });
      assert.throws(() => process.kill(owner.browserPid, 0), { code: "ESRCH" });
    }
    assert.match(await readFile(manualEvidence.paths.html!, "utf8"), /Manual edit/);
    assert.equal((await first.snapshots.read(snapshotId(firstManual), "screenshot")).image?.mimeType, "image/png", "shutdown preserves evidence");
  });
}
