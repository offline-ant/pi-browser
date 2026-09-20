import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBrowserTool } from "../src/browser-tool.ts";
import { remoteNames, remoteSocketPath } from "../src/browser-remote.ts";
import { Bidi, object } from "../src/core/bidi.ts";
import { BrowserProcessLauncher, findBrowserExecutable } from "../src/core/index.ts";

test("published Firefox socket: retry once, reuse the destination tab, preserve the publisher and human tab", { timeout: 45_000 }, async t => {
  const cleanups: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const root = await mkdtemp(path.join(tmpdir(), "pi-remote-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_BROWSER_REMOTE: process.env.PI_BROWSER_REMOTE };
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_BROWSER_REMOTE = "desktop";
  cleanups.push(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  // Refuse an occupied port; never contact or alter an existing desktop browser.
  const reservation = createServer();
  reservation.listen(9222, "127.0.0.1");
  await once(reservation, "listening");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const executable = await findBrowserExecutable("firefox");
  assert(executable, "This focused integration test requires Firefox");
  const profile = path.join(root, "publisher-profile");
  await mkdir(profile, { mode: 0o700 });
  const child = spawn(executable, ["--headless", "--new-instance", "--profile", profile,
    "--remote-debugging-port", "9222", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  });
  await new Promise<void>((resolve, reject) => {
    let diagnostic = "";
    const timer = setTimeout(() => reject(new Error(`Disposable Firefox failed to start: ${diagnostic}`)), 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(diagnostic)); });
    child.stderr.on("data", chunk => {
      diagnostic += String(chunk);
      if (/WebDriver BiDi listening on ws:\/\/.*:9222/.test(diagnostic)) { clearTimeout(timer); resolve(); }
    });
  });
  const human = await Bidi.connect("ws://127.0.0.1:9222/session");
  await human.request("session.new", { capabilities: {} });
  const initial = await human.request("browsingContext.getTree");
  assert(Array.isArray(initial.contexts));
  assert.equal(initial.contexts.length, 1);
  await human.request("script.evaluate", { expression: "document.title = 'Human blank tab'",
    target: { context: object(initial.contexts[0]).context }, awaitPromise: true });
  await human.request("session.end");
  human.close();

  // A byte-for-byte Unix-to-TCP forward models SSH's streamlocal forwarding.
  const sockets = new Set<Socket>();
  const forward = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: 9222 });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream).pipe(client);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    if (forward.listening) await new Promise<void>(resolve => forward.close(() => resolve()));
  });
  let confirmations = 0;
  const launches = t.mock.method(BrowserProcessLauncher, "create", async () => { throw new Error("No local fallback permitted"); });
  const tools = createBrowserTool({ profileDir: path.join(root, "manual"), artifactDir: path.join(root, "evidence"), browser: "firefox",
    onSetup: async (instructions, signal) => {
      confirmations++;
      assert.equal(signal.aborted, false);
      assert.match(instructions, /browser-remote-setup \[pi-ssh-target\]/);
      assert(!instructions.includes(root), "model instructions use only the remote name");
      assert.deepEqual(remoteNames(), []);
      forward.listen(remoteSocketPath("desktop"));
      await once(forward, "listening");
      return true;
    },
  });
  cleanups.push(() => tools.close());
  const execute = (params: Parameters<typeof tools.tool.execute>[1]) => tools.tool.execute("fixture", params, undefined, undefined, {} as ExtensionContext);
  const first = await execute({ eval: "globalThis.fixtureCount = (globalThis.fixtureCount || 0) + 1" });
  const second = await execute({ remote: "desktop", eval: "++globalThis.fixtureCount" });
  assert.equal(first.details.remote, "desktop", "environment default selects the publisher");
  assert.equal(first.details.eval_result, 1, "retry never repeats evaluation");
  assert.equal(second.details.eval_result, 2, "the destination retains page state");
  assert.equal(first.details.tab_id, second.details.tab_id, "the same destination reuses exactly one owned tab");
  await assert.rejects(execute({ browser: "chromium" }), /Use \/browser-close desktop before changing its engine/);
  assert(!JSON.stringify(first).includes(root));
  assert.equal(confirmations, 1);
  assert.equal(launches.mock.callCount(), 0);
  assert.deepEqual(remoteNames(), ["desktop"]);
  assert.equal((await stat(path.dirname(remoteSocketPath("desktop")))).mode & 0o777, 0o700);
  await tools.closeBrowser();
  assert.equal((await execute({ eval: "typeof globalThis.fixtureCount" })).details.eval_result, "undefined");
  await tools.closeBrowser("desktop");
  await tools.close();
  assert.equal(child.exitCode, null, "tool shutdown never stops the publisher");
  const check = await Bidi.connect("ws://127.0.0.1:9222/session");
  try {
    await check.request("session.new", { capabilities: {} });
    const final = await check.request("browsingContext.getTree");
    assert(Array.isArray(final.contexts));
    assert.equal(final.contexts.length, 1, "all owned tabs were closed");
    assert.equal(object(final.contexts[0]).url, "about:blank");
    // Firefox assigns fresh context IDs per automation session; the DOM marker persists.
    const marker = await check.request("script.evaluate", { expression: "document.title",
      target: { context: object(final.contexts[0]).context }, awaitPromise: true });
    assert.equal(object(marker.result).value, "Human blank tab", "the original human blank tab was never adopted");
    await check.request("session.end");
  } finally { check.close(); }
});
