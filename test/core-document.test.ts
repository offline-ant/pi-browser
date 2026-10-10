import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launchBrowser, ScriptError } from "../src/core/index.ts";
import type { BrowserSession } from "../src/core/types.ts";
import { waitFor } from "./helpers.ts";

// A dedicated single-tab browser: the startup tab, protocol document identity, document-bound
// evaluation, reload and page-creation watching. Chromium only; Firefox has none of these yet.
test("chromium: a launched browser's startup tab is its only tab and exposes its live document", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-browser-document-"));
  let loads = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: "/elsewhere" }); response.end(); return; }
    if (request.url === "/favicon.ico") { response.writeHead(404); response.end(); return; }
    loads += 1;
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(`<!doctype html><title>${request.url}</title><script>window.load = ${loads};</script>`);
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
  browser = await launchBrowser({ browser: "chromium", profileDir: directory, headless: true });
  const created: string[] = [];
  browser.onPage(page => created.push(page.id));
  const tab = await browser.startupTab();
  await assert.rejects(browser.startupTab(), /unclaimed startup tab/);
  assert.deepEqual((await browser.pages()).map(page => page.id), [tab.id]);

  await tab.navigate(`${origin}/page`);
  const first = await tab.document();
  assert.equal(first.url, `${origin}/page`);
  assert.equal(await tab.evaluate("window.load", { document: first.id }), 1);
  await assert.rejects(tab.evaluate("missing.value", { document: first.id }), ScriptError);

  await tab.evaluate("location.hash = 'part'; history.pushState(null, '', '/pushed#x')", { document: first.id });
  assert.deepEqual(await tab.document(), { id: first.id, url: `${origin}/pushed#x` }, "same-document changes keep the document");

  const reloaded = await tab.reload();
  assert.notEqual(reloaded.id, first.id);
  assert.equal(reloaded.url, `${origin}/pushed#x`, "reload keeps the URL, fragment included");
  assert.equal(await tab.evaluate("window.load", { document: reloaded.id }), 2);
  await assert.rejects(tab.evaluate("1", { document: first.id }), error => !(error instanceof ScriptError), "a replaced document refuses evaluation");

  await tab.navigate(`${origin}/redirect`);
  assert.equal((await tab.document()).url, `${origin}/elsewhere`, "the protocol reports a redirect's destination");

  assert.equal(await tab.evaluate("window.open('/popup') === null", { document: (await tab.document()).id }), true,
    "evaluation carries no user gesture, so the popup blocker refuses it");
  const other = await browser.openTab();
  await waitFor(() => created.length === 1, 5_000, "the new page to be reported");
  assert.deepEqual(created, [other.id]);

  await tab.close();
  await tab.whenClosed;
  assert.equal(tab.closed, true);
});

test("chromium: kill() ends a launched browser at once", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-browser-kill-"));
  const browser = await launchBrowser({ browser: "chromium", profileDir: directory, headless: true });
  t.after(async () => { await browser.close(); await rm(directory, { recursive: true, force: true }); });
  const tab = await browser.startupTab();
  browser.kill();
  await tab.whenClosed;
  assert.equal(browser.closed, true);
});
