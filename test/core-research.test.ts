import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { launchBrowser } from "../src/core/index.ts";
import type { BrowserKind, BrowserSession } from "../src/core/types.ts";

for (const kind of ["chromium", "firefox"] as const satisfies readonly BrowserKind[]) {
  test(`${kind}: research tabs preserve independent DOM, shared cookies and stable identity`, { timeout: 60_000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), `pi-browser-${kind}-`));
    const server = createServer((request, response) => {
      if (request.url === "/redirect") { response.writeHead(302, { location: "/destination" }); response.end(); return; }
      if (request.url === "/slow") {
        setTimeout(() => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<title>slow</title>"); }, 350);
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end(`<!doctype html><title>${request.url}</title><main><h1>Research fixture</h1><p>Readable content.</p></main><script>
        window.marker = ${JSON.stringify(request.url)};
        const shadow = document.querySelector('main').appendChild(document.createElement('x-example')).attachShadow({mode:'open'});
        shadow.innerHTML = '<pre>const example = 1;</pre>';
      </script>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    let browser: BrowserSession | undefined;
    t.after(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    const launch = () => launchBrowser({ browser: kind, profileDir: directory, headless: true,
      ...(kind === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" ? { noSandbox: true } : {}) });
    browser = await launch();
    const first = await browser.openTab(`${origin}/one`);
    const second = await browser.openTab(`${origin}/two`);
    assert.equal(browser.closed, false);
    assert.equal(first.closed, false);
    assert.equal(second.closed, false);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(await first.info(), { url: `${origin}/one`, title: "/one" });
    assert.equal(await second.evaluate("window.marker"), "/two");
    assert.equal(await first.evaluate("typeof aos"), "undefined", "external tabs never receive the pagent bridge");
    assert.equal(await first.evaluate("document.querySelector('x-example').shadowRoot.querySelector('pre').textContent"), "const example = 1;");
    await first.evaluate("document.cookie = 'research=shared; path=/; Max-Age=3600'");
    assert.match(String(await second.evaluate("document.cookie")), /research=shared/);
    const value = await first.evaluate("(async () => { await Promise.resolve(); return { value: [1, true, null] }; })()");
    assert.deepEqual(value, { value: [1, true, null] });
    await assert.rejects(first.evaluate("(() => { throw new Error('fixture exception'); })()"), /fixture exception/);
    await assert.rejects(first.navigate("file:///etc/passwd"), /HTTP or HTTPS/);
    assert.equal(await first.evaluate("window.marker"), "/one", "ordinary script or URL errors do not destroy the tab");
    await assert.rejects(first.navigate(`${origin}/slow`, { timeoutMs: 60 }), /timed out/);
    await first.navigate(`${origin}/redirect`);
    assert.deepEqual(await first.info(), { url: `${origin}/destination`, title: "/destination" });
    await first.evaluate("window.sameDocumentMarker = 'retained'");
    await first.navigate(`${origin}/destination#fragment`, { timeoutMs: 2_000 });
    assert.equal((await first.info()).url, `${origin}/destination#fragment`);
    await first.navigate(`${origin}/destination#second`, { timeoutMs: 2_000 });
    assert.equal((await first.info()).url, `${origin}/destination#second`);
    assert.equal(await first.evaluate("window.sameDocumentMarker"), "retained", "fragment navigation preserves the document");
    assert.match(await first.html(), /<!DOCTYPE html>.*|Research fixture/s);
    const screenshot = Buffer.from(await first.screenshot(), "base64");
    assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await first.focus();

    const alreadyAborted = AbortSignal.abort(new Error("do not execute"));
    await assert.rejects(first.evaluate("window.marker = 'wrong'", { signal: alreadyAborted }), /do not execute/);
    assert.equal(await first.evaluate("window.marker"), "/destination");
    const pending = first.evaluate("new Promise(resolve => setTimeout(() => resolve('complete'), 400))");
    let settled = false;
    void pending.then(() => { settled = true; });
    const queuedAbort = new AbortController();
    const queued = first.evaluate("window.marker = 'also wrong'", { signal: queuedAbort.signal });
    const checked = assert.rejects(queued, /queued cancelled/);
    queuedAbort.abort(new Error("queued cancelled"));
    await checked;
    assert.equal(settled, false, "queued cancellation returns without waiting for unrelated running code");
    await assert.rejects(first.evaluate("window.marker = 'timed out wrong'", { timeoutMs: 30 }), /timed out.*queued/);
    assert.equal(settled, false);
    assert.equal(await pending, "complete");
    assert.equal(await first.evaluate("window.marker"), "/destination");
    assert.equal(first.closed, false, "queued interruption never closes an executing tab");
    const identity = second.id;
    await second.evaluate(`setTimeout(() => { location.href = ${JSON.stringify(`${origin}/manual`)}; }, 20)`);
    for (let count = 0; count < 100 && (await second.info()).url !== `${origin}/manual`; count++) await delay(20);
    assert.equal((await second.info()).url, `${origin}/manual`);
    assert.equal(second.id, identity, "manual navigation retains the exact owned target");
    await second.navigate(`${origin}/after-manual`);
    assert.equal((await second.info()).url, `${origin}/after-manual`);
    const manual = await browser.openTab();
    await manual.evaluate("setTimeout(() => window.close(), 20)");
    for (let count = 0; count < 100 && !manual.closed; count++) await delay(20);
    assert.equal(manual.closed, true, "manual target closure marks the public handle closed");
    await assert.rejects(manual.info(), /closed/);
    await second.close();
    await second.close();
    assert.equal(second.closed, true);
    await assert.rejects(second.info(), /closed/);
    assert.equal(await first.evaluate("1 + 1"), 2);
    await browser.close();
    await browser.close();
    assert.equal(browser.closed, true);
    assert.equal(first.closed, true);
    await assert.rejects(browser.openTab(), /closed/);
    await assert.rejects(first.info(), /closed/);
    browser = await launch();
    assert.equal(browser.closed, false);
    const restored = await browser.openTab(`${origin}/restored`);
    assert.match(String(await restored.evaluate("document.cookie")), /research=shared/, "profile cookies survive clean process restart");
  });

  test(`${kind}: running-evaluation timeout and cancellation are bounded and honest`, { timeout: 45_000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), `pi-browser-interrupt-${kind}-`));
    let resumed = false;
    const server = createServer((request, response) => {
      if (request.url === "/resumed") resumed = true;
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Cancellation fixture</title>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    let browser: BrowserSession | undefined;
    t.after(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    const launch = () => launchBrowser({ browser: kind, profileDir: directory, headless: true,
      ...(kind === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" ? { noSandbox: true } : {}) });
    browser = await launch();
    const first = await browser.openTab();
    const sibling = await browser.openTab();
    const timeoutStarted = Date.now();
    await assert.rejects(first.evaluate("while (true) {}", { timeoutMs: 100 }), /timed out.*closed/);
    assert(Date.now() - timeoutStarted < 8_000, "hung-script cleanup is bounded");
    assert.equal(first.closed, true);
    assert.equal(browser.closed, kind === "firefox");
    assert.equal(sibling.closed, kind === "firefox");
    if (kind === "chromium") {
      await assert.rejects(first.evaluate("7"), /closed/);
      assert.equal(await sibling.evaluate("9"), 9, "Chromium preserves other tabs when destroying the interrupted context");
    } else {
      await assert.rejects(first.evaluate("7"), /closed/);
      await assert.rejects(sibling.evaluate("9"), /closed/);
      await assert.rejects(browser.openTab(), /closed/);
      browser = await launch();
    }
    const page = await browser.openTab(origin);
    const abort = new AbortController();
    const pending = page.evaluate("(async () => { await new Promise(resolve => setTimeout(resolve, 400)); await fetch('/resumed'); })()", { signal: abort.signal, timeoutMs: 20_000 });
    const checked = assert.rejects(pending, kind === "firefox" ? /cancelled.*Research Firefox stopped/ : /cancelled.*Chromium tab closed/);
    await delay(50);
    const cancellationStarted = Date.now();
    abort.abort();
    await checked;
    assert(Date.now() - cancellationStarted < 8_000, "cancellation cleanup is bounded");
    assert.equal(page.closed, true);
    assert.equal(browser.closed, kind === "firefox");
    await assert.rejects(page.evaluate("11"), /closed/);
    await delay(450);
    assert.equal(resumed, false, "cancelled asynchronous JavaScript must not resume later");

    if (kind === "firefox") browser = await launch();
    const unresolved = await browser.openTab();
    await assert.rejects(unresolved.evaluate("new Promise(() => {})", { timeoutMs: 100 }), /timed out.*closed/);
    await assert.rejects(unresolved.evaluate("13"), /closed/);
  });
}
