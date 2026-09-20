import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { createBrowserTool } from "../src/browser-tool.ts";
import { BrowserProcessLauncher } from "../src/core/index.ts";

const context = {} as ExtensionContext;
type Params = Parameters<ReturnType<typeof createBrowserTool>["tool"]["execute"]>[1];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser}: browser tool artifacts, ordering, cancellation and recovery`, { timeout: 90_000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-browser-tool-"));
    let entered = deferred();
    let gate: ServerResponse | undefined;
    const navigations: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === "/gate") { gate = response; entered.resolve(); return; }
      navigations.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end(`<!doctype html><title>${request.url}</title><main>Original fixture</main>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const create = BrowserProcessLauncher.create;
    const launches = t.mock.method(BrowserProcessLauncher, "create", create);
    const set = createBrowserTool({ profileDir: path.join(root, "manual"), artifactDir: path.join(root, "artifacts"), browser: browser === "chromium" ? "firefox" : "chromium", headless: true });
    const execute = (params: Params, signal?: AbortSignal) => set.tool.execute("test", params, signal, undefined, context);
    t.after(async () => {
      gate?.end();
      await set.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    assert(Check(set.tool.parameters, { browser, url: origin, eval: "1" }));
    assert(!Check(set.tool.parameters, { session_id: "default" }));
    assert(!Check(set.tool.parameters, { backend: "browser" }));
    for (const params of [{ remote: "../escape" }, { url: "file:///etc/passwd" }, { url: "https://user:pass@example.com" }]) {
      await assert.rejects(execute(params));
    }
    assert.equal(launches.mock.callCount(), 0);
    const [first, second] = await Promise.all([
      execute({ browser, url: `${origin}/one`, eval: "document.querySelector('main').textContent = 'Edited fixture'" }),
      execute({ eval: "document.querySelector('main').textContent" }),
    ]);
    assert.equal(launches.mock.callCount(), 1, "same-destination concurrent calls share one process/profile request");
    assert.equal(second.details.eval_result, "Edited fixture");
    assert.equal(first.details.tab_id, second.details.tab_id);
    const firstSnapshot = await set.snapshots.info(first.details.snapshot);
    assert.deepEqual(firstSnapshot.available, ["md", "text", "html", "json", "screenshot", "before-screenshot"]);
    assert.match(await readFile(firstSnapshot.paths.html!, "utf8"), /Edited fixture/);
    assert.doesNotMatch(JSON.stringify(first.content), /before_html|after_html|\/tmp\//);
    for (const file of Object.values(firstSnapshot.paths)) assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(firstSnapshot.paths.html!))).mode & 0o777, 0o700);
    assert.deepEqual([...(await readFile(firstSnapshot.paths.screenshot!)).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await assert.rejects(execute({ browser: browser === "chromium" ? "firefox" : "chromium", url: `${origin}/wrong` }), /Use \/browser-close before changing its engine/);
    assert.equal((await execute({ eval: "document.querySelector('main').textContent" })).details.eval_result, "Edited fixture");
    assert(!navigations.includes("/wrong"));
    assert.equal(launches.mock.callCount(), 1);
    const thrown = await execute({ eval: "(() => { throw new Error('fixture eval failure'); })()" });
    assert.match(thrown.details.eval_error ?? "", /fixture eval failure/);
    assert.equal(thrown.details.tab_id, first.details.tab_id);
    assert.match((await set.snapshots.read(thrown.details.snapshot, "html")).text!, /Edited fixture/);
    for (const expression of ["'x'.repeat(60 * 1024)", "Array.from({ length: 2200 }, (_, i) => i)"]) {
      const result = await execute({ eval: expression });
      assert.equal(result.details.truncated, true);
      assert.equal(result.content[0]!.type, "text");
      if (result.content[0]!.type !== "text") throw new Error("Expected text output");
      assert.match(result.content[0]!.text, /preview truncated; full captured result/);
      assert(Buffer.byteLength(result.content[0]!.text) < 9 * 1024);
      const saved = JSON.parse(await readFile((await set.snapshots.info(result.details.snapshot)).paths.json!, "utf8"));
      assert.deepEqual(saved.metadata.eval_result, expression.startsWith("'x'") ? "x".repeat(60 * 1024) : Array.from({ length: 2200 }, (_, i) => i));
      assert.equal(result.details.eval_result, undefined, "large results are not duplicated in details");
    }

    // Hold real asynchronous JavaScript at a local HTTP gate, not a timing guess.
    const running = execute({ eval: "(async () => { await fetch('/gate'); document.title = 'eval completed'; return document.title; })()" });
    await entered.promise;
    let finished = false;
    void running.then(() => { finished = true; });
    const abort = new AbortController();
    const cancelled = execute({ url: `${origin}/cancelled`, eval: "document.title = 'wrong'" }, abort.signal);
    const checked = assert.rejects(cancelled, /queued cancelled/);
    const navigation = execute({ url: `${origin}/two`, eval: "document.title" });
    abort.abort(new Error("queued cancelled"));
    await Promise.race([checked, delay(1000).then(() => { throw new Error("Queued cancellation did not settle promptly"); })]);
    assert.equal(finished, false);
    assert(!navigations.includes("/two"), "navigation must wait for the earlier evaluation and captures");
    gate!.end("continue");
    assert.equal((await running).details.title, "eval completed");
    assert.equal((await navigation).details.eval_result, "/two");
    assert(!navigations.includes("/cancelled"));
    assert.equal(launches.mock.callCount(), 1, "queued cancellation never closes the running tab");

    // /browser-close must be in the same queue, including calls submitted while
    // it waits. A new operation must never run on a closing owner or lose its slot.
    entered = deferred();
    const beforeClose = execute({ eval: "fetch('/gate').then(() => 'before close')" });
    await entered.promise;
    const close = set.closeBrowser();
    const reopened = execute({ browser, url: `${origin}/reopened`, eval: "document.title" });
    gate!.end("continue");
    assert.equal((await beforeClose).details.eval_result, "before close");
    await close;
    const restored = await reopened;
    assert.equal(restored.details.title, "/reopened");
    assert.equal(launches.mock.callCount(), 2);

    // Simulate an external close of this disposable process, never a user's
    // browser. The profile lease records the exact process created by this test.
    const ownerFile = path.join(root, "manual", browser, ".pi-browser-owner", "owner.json");
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.browserPid, "number");
    process.kill(owner.browserPid, "SIGTERM");
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await stat(ownerFile); } catch { break; }
      await delay(50);
    }
    const manualRecovery = await execute({ url: `${origin}/manual-recovery`, eval: "document.title" });
    assert.equal(manualRecovery.details.title, "/manual-recovery");
    assert.equal(manualRecovery.details.browser, browser, "recovery retains the destination's engine, not the host default");
    assert.notEqual(manualRecovery.details.tab_id, restored.details.tab_id);

    entered = deferred();
    const interrupted = execute({ eval: "fetch('/gate').then(() => { document.title = 'must not resume'; })" });
    let interruptedSnapshot = "";
    const interruption = assert.rejects(interrupted, (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /cancelled.*closed|cancelled.*stopped/i);
      interruptedSnapshot = /Snapshot: (snap_[a-f0-9]{32})/.exec(error.message)?.[1] ?? "";
      assert(interruptedSnapshot);
      return true;
    });
    await entered.promise;
    const shutdown = set.close();
    assert.equal(shutdown, set.close(), "cleanup is idempotent");
    await assert.rejects(execute({}), /closed/);
    await assert.rejects(set.closeBrowser(), /closed/);
    await interruption;
    const interruptedInfo = await set.snapshots.info(interruptedSnapshot);
    assert(interruptedInfo.available.includes("before-screenshot"));
    assert(!interruptedInfo.available.includes("screenshot"), "cancelled eval must not capture a fake final image");
    await shutdown;
    const profiles = await readdir(path.join(root, "manual", browser));
    assert(!profiles.includes(".pi-browser-owner"));
  });
}
