import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "../src/broker/client.ts";
import { processAlive } from "../src/broker/protocol.ts";
import { createBrowserTool, type BrowserListDetails, type BrowserResultDetails } from "../src/browser-tool.ts";
import { remoteNames, remoteSocketPath } from "../src/browser-remote.ts";
import { findBrowserExecutable } from "../src/core/index.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { brokerPids, fixtureServer, isolateBrokers, waitFor } from "./helpers.ts";

for (const engine of ["firefox", "chromium"] as const) {
  test(`published ${engine} socket: engine detection, one confirmed retry, human tabs and the publisher survive`, { timeout: 60_000 }, async t => {
    const cleanups: (() => unknown | Promise<unknown>)[] = [];
    t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
    const root = await isolateBrokers(t);
    const origin = await fixtureServer(t, (request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>${request.url === "/human" ? "Human tab" : request.url}</title>`);
    });
    const HUMAN = `${origin}/human`;
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    cleanups.push(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });

    // Refuse an occupied port; never contact or alter an existing desktop browser.
    const reservation = createServer();
    reservation.listen(9222, "127.0.0.1");
    await once(reservation, "listening");
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const executable = await findBrowserExecutable(engine);
    assert(executable, `This focused integration test requires ${engine}`);
    const profile = path.join(root, "publisher-profile");
    await mkdir(profile, { mode: 0o700 });
    const child = spawn(executable, engine === "firefox"
      ? ["--headless", "--new-instance", "--profile", profile, "--remote-debugging-port", "9222", HUMAN]
      : ["--headless=new", "--remote-debugging-port=9222", `--user-data-dir=${profile}`, "--no-first-run", HUMAN], { stdio: ["ignore", "ignore", "pipe"] });
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
      const timer = setTimeout(() => reject(new Error(`Disposable ${engine} failed to start: ${diagnostic}`)), 15_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(diagnostic)); });
      child.stderr.on("data", chunk => {
        diagnostic += String(chunk);
        if (/(WebDriver BiDi|DevTools) listening on ws:\/\/.*:9222/.test(diagnostic)) { clearTimeout(timer); resolve(); }
      });
    });

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
    const socketPath = remoteSocketPath("desk");
    let confirmations = 0;
    const source = { remote: "desk", socketPath };
    const client = new BrowserClient({ source, session: "A", idleMs: 300 });
    cleanups.push(() => client.close());
    const tools = createBrowserTool({ browser: () => client, snapshots: new SnapshotStore({ directory: path.join(root, "evidence") }),
      onSetup: async (instructions, signal) => {
        confirmations++;
        assert.equal(signal.aborted, false);
        assert.match(instructions, /Could not connect to remote desk/);
        assert.match(instructions, /browser-remote-setup \[pi-ssh-target\]/);
        assert(!instructions.includes(root), "model instructions use only the remote name");
        assert.deepEqual(remoteNames(), []);
        forward.listen(socketPath);
        await once(forward, "listening");
        return true;
      },
    });
    const execute = (params: Parameters<typeof tools.tool.execute>[1]) => tools.tool.execute("fixture", params, undefined, undefined, {} as ExtensionToolContext);

    const listed = await execute({ list: true });
    assert.equal(confirmations, 1);
    const [human] = (listed.details as BrowserListDetails).tabs;
    assert.equal((listed.details as BrowserListDetails).tabs.length, 1);
    assert.deepEqual([human!.openedBy, human!.url], ["other", HUMAN]);
    assert.equal(((await execute({ tab: human!.name, eval: "document.title" })).details as BrowserResultDetails).eval_result, "Human tab");
    const first = (await execute({ tab: "work", url: `${origin}/work`, eval: "globalThis.count = (globalThis.count || 0) + 1" })).details as BrowserResultDetails;
    const second = (await execute({ eval: "++globalThis.count" })).details as BrowserResultDetails;
    assert.deepEqual([first.browser, first.remote, first.tab, first.eval_result], [engine, "desk", "work", 1], "the engine is detected from the socket");
    assert.deepEqual([second.tab, second.eval_result], ["work", 2], "retry never repeats evaluation; the tab keeps its state");
    assert(!JSON.stringify(first).includes(root));
    assert.equal(confirmations, 1);
    assert.deepEqual(remoteNames(), ["desk"]);
    assert.equal((await stat(path.dirname(socketPath))).mode & 0o777, 0o700);

    // The idle broker closes only its own tabs and leaves the publisher running.
    const [broker] = await brokerPids(root);
    await client.close();
    await waitFor(() => !processAlive(broker), 10_000, "the broker to exit");
    assert.equal(child.exitCode, null, "the publisher keeps running");
    const check = new BrowserClient({ source, session: "B", idleMs: 300 });
    cleanups.push(() => check.close());
    const remaining = await check.list();
    assert.deepEqual(remaining.map(tab => [tab.url, tab.openedBy]), [[HUMAN, "other"]], "broker-opened tabs closed; the human tab was never adopted or closed");
    await check.close();
  });
}
