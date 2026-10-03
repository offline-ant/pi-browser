import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BrowserClient, SharedTab } from "../src/broker/client.ts";
import type { OperationOptions } from "../src/core/types.ts";
import { BrowserResearch, WebAttentionRequired } from "../src/web/browser.ts";
import { captureExpression, type PageInspection } from "../src/web/extract.ts";
import type { PageCapture } from "../src/capture.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { resolveWebSettings } from "../src/web/settings.ts";
import { fixtureClient, fixtureServer, isolateBrokers, type ResearchTab } from "./helpers.ts";

class FixtureTab implements ResearchTab {
  readonly name: string;
  closed = false;
  navigations = 0;
  focuses = 0;
  attention = true;
  error?: Error;
  captureError?: Error;
  screenshotError?: Error;
  captures = 0;
  screenshots = 0;
  results: PageInspection["results"] = [];
  constructor(name: string) { this.name = name; }
  async navigate(): Promise<void> { assert.equal(this.closed, false); this.navigations++; }
  async evaluate(expression: string): Promise<PageInspection | PageCapture> {
    assert.equal(this.closed, false);
    const inspection: PageInspection = { url: "https://example.com/", title: "Fixture", ready: true, noResults: false, results: this.results, markdown: "# Readable fixture", limitations: [], ...(this.attention ? { attention: "Complete the challenge." } : {}) };
    if (expression === captureExpression("fetch", "duckduckgo") || expression === captureExpression("search", "duckduckgo")) {
      this.captures++;
      if (this.captureError) throw this.captureError;
      return { html: "<main>Captured fixture</main>", md: "# Readable fixture", text: "Readable fixture", json: { ...inspection, captured: true }, warnings: [], capturedAt: new Date().toISOString() };
    }
    if (this.error) throw this.error;
    return inspection;
  }
  async screenshot() {
    this.screenshots++;
    if (this.screenshotError) throw this.screenshotError;
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=";
  }
  async focus() { this.focuses++; }
  async close() { this.closed = true; }
}

class Fixtures {
  tabs: FixtureTab[] = [];
  client(headless = false) {
    return fixtureClient(() => {
      const tab = new FixtureTab(`fixture-${this.tabs.length}`);
      this.tabs.push(tab);
      return tab;
    }, headless);
  }
}

test("closed pending tab is replaced only on the next call, preserving sibling tabs", async t => {
  const browser = new Fixtures();
  const research = new BrowserResearch(resolveWebSettings({}, {}), browser.client());
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/a", 5), WebAttentionRequired);
  await assert.rejects(research.run("fetch", "https://example.com/b", 5), WebAttentionRequired);
  await browser.tabs[0]!.close();
  const messages: string[] = [];
  await assert.rejects(research.run("fetch", "https://example.com/a", 5, undefined, undefined, message => messages.push(message)), WebAttentionRequired);
  assert.equal(browser.tabs.length, 3);
  assert.equal(browser.tabs[1]!.closed, false);
  assert.equal(browser.tabs[2]!.navigations, 1);
  assert.ok(messages.some(message => /fresh tab/.test(message)));
  assert.ok(messages.every(message => !/Resuming/.test(message)));
});

test("each attention wait has a fresh ID, including an unchanged challenge and a later retry", async t => {
  const browser = new Fixtures();
  const research = new BrowserResearch(resolveWebSettings({}, {}), browser.client());
  t.after(() => research.close());
  const ids: string[] = [];
  await assert.rejects(research.run("fetch", "https://example.com/", 5, undefined, async request => {
    ids.push(request.id);
    return ids.length === 1;
  }), WebAttentionRequired);
  await assert.rejects(research.run("fetch", "https://example.com/", 5, undefined, async request => {
    ids.push(request.id); return false;
  }), WebAttentionRequired);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert.equal(browser.tabs[0]!.navigations, 1);
});

test("headless attention reports missing visible window and focuses only to render captures", async t => {
  const browser = new Fixtures();
  const research = new BrowserResearch(resolveWebSettings({}, {}), browser.client(true));
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/", 5), /headless; no visible window/);
  let reason = "";
  await assert.rejects(research.run("fetch", "https://example.com/", 5, undefined, async request => { reason = request.reason; return false; }), WebAttentionRequired);
  assert.match(reason, /headless: no visible window/);
  assert.equal(browser.tabs[0]!.focuses, browser.tabs[0]!.screenshots);
});

test("ordinary errors and progress exceptions are propagated without automatic retries", async t => {
  const browser = new Fixtures();
  const research = new BrowserResearch(resolveWebSettings({}, {}), browser.client());
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/", 5, undefined, undefined, () => { throw new Error("progress callback failed"); }), /progress callback failed/);
  assert.equal(browser.tabs.length, 0);
  await assert.rejects(research.run("fetch", "https://example.com/", 5), WebAttentionRequired);
  const tab = browser.tabs[0]!;
  tab.error = new Error("ordinary inspection failed");
  await assert.rejects(research.run("fetch", "https://example.com/", 5), /ordinary inspection failed/);
  assert.equal(browser.tabs.length, 1);
  assert.equal(tab.navigations, 1);
  assert.equal(tab.closed, false);
});

test("cancellation after opening a tab leaves it unvisited and never resumes blank content", async t => {
  const controller = new AbortController();
  const browser = new Fixtures();
  const client = browser.client();
  const research = new BrowserResearch(resolveWebSettings({}, {}), fixtureClient(async () => {
    const { tab } = await client.open({});
    if (browser.tabs.length === 1) controller.abort(new Error("cancelled while opening"));
    return tab;
  }));
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/", 5, controller.signal), /cancelled while opening/);
  await assert.rejects(research.run("fetch", "https://example.com/", 5), WebAttentionRequired);
  assert.equal(browser.tabs[0]!.navigations, 0);
  assert.equal(browser.tabs[1]!.navigations, 1);
});

test("queued cancellation saves diagnostics without releasing the active browser queue or mutating its reason", { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-web-queue-"));
  const snapshots = new SnapshotStore({ directory: path.join(directory, "snapshots") });
  const browser = new Fixtures();
  const research = new BrowserResearch(resolveWebSettings({}, {}), browser.client(), snapshots);
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  let release!: (continued: boolean) => void;
  const continued = new Promise<boolean>(resolve => { release = resolve; });
  t.after(async () => { release(false); await research.close(); await rm(directory, { recursive: true, force: true }); });
  const active = research.run("fetch", "https://example.test/active", 10, undefined, async () => { ready(); return continued; });
  const activeRejected = assert.rejects(active, WebAttentionRequired);
  await waiting;
  const controller = new AbortController();
  const reason = new Error("cancel queued fixture");
  const queued = research.run("fetch", "https://example.test/queued", 10, controller.signal);
  controller.abort(reason);
  await assert.rejects(queued, /cancel queued fixture[\s\S]*Snapshot: snap_/);
  assert.equal(reason.message, "cancel queued fixture");
  const next = research.run("fetch", "https://example.test/next", 10);
  const nextRejected = assert.rejects(next, WebAttentionRequired);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(browser.tabs.length, 1, "a cancelled waiter must not let the next call bypass active attention");
  release(false);
  await activeRejected;
  await nextRejected;
  assert.equal(browser.tabs.length, 2);
});

test("browser snapshots eagerly save full captured results and evidence, including nonfatal screenshot failures", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-web-producer-"));
  const snapshots = new SnapshotStore({ directory: path.join(directory, "snapshots") });
  const browser = new Fixtures();
  const research = new BrowserResearch(resolveWebSettings({}, {}), browser.client(), snapshots);
  t.after(async () => { await research.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await research.run("search", "fixture", 10, undefined, async () => {
    const tab = browser.tabs.at(-1)!;
    tab.attention = false;
    tab.results = Array.from({ length: 18 }, (_, index) => ({ title: `Source ${index + 1}`, url: `https://example.test/${index + 1}`, snippet: "excerpt ".repeat(100) }));
    return true;
  });
  assert.equal(result.results?.length, 10);
  assert.equal(result.sourceCount, 18);
  assert.match(result.output, /10\. \[Source 10\]/);
  assert.doesNotMatch(result.output, /Source 11/);
  assert.ok(result.output.length < 6000);
  assert.equal(browser.tabs[0]!.captures, 1);
  assert.equal(browser.tabs[0]!.screenshots, 1);
  const id = result.snapshot!.id;
  assert.deepEqual(result.snapshot!.available, ["md", "text", "html", "json", "screenshot"]);
  assert.match((await snapshots.read(id, "md")).text!, /Source 18/);
  const json = JSON.parse(JSON.parse((await snapshots.read(id, "json")).text!).chunk);
  assert.equal(json.data.results.length, 18);
  assert.equal(json.data.captured, true);
  assert.ok(json.metadata.screenshotCapturedAt);
  const degraded = await research.run("fetch", "https://example.test/degraded", 10, undefined, async () => {
    const tab = browser.tabs.at(-1)!;
    tab.attention = false;
    tab.screenshotError = new Error("screenshot fixture failure");
    return true;
  });
  assert.match(degraded.output, /Readable fixture/);
  assert.match(degraded.snapshot!.warnings.join(" "), /screenshot fixture failure/);
  assert.ok(degraded.snapshot!.available.includes("html"));
  assert.ok(!degraded.snapshot!.available.includes("screenshot"));
  await research.close();
  assert.ok((await snapshots.read(id, "screenshot")).image);
  assert.match((await snapshots.read(id, "html")).text!, /Captured fixture/);
  assert.equal(browser.tabs[0]!.captures, 1, "offline reads never revisit the page");
});

test("browser failures retain diagnostic snapshots and completed captures without replaying navigation", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-web-producer-error-"));
  const snapshots = new SnapshotStore({ directory: path.join(directory, "snapshots") });
  const browser = new Fixtures();
  const research = new BrowserResearch(resolveWebSettings({}, {}), browser.client(), snapshots);
  t.after(async () => { await research.close(); await rm(directory, { recursive: true, force: true }); });
  let failure: unknown;
  try { await research.run("fetch", "https://example.test/", 10); } catch (error) { failure = error; }
  assert.ok(failure instanceof WebAttentionRequired);
  const id = failure.message.match(/snap_[a-f0-9]{32}/)?.[0];
  assert.ok(id);
  assert.match((await snapshots.read(id, "html")).text!, /Captured fixture/);
  assert.ok((await snapshots.read(id, "screenshot")).image);
  const json = JSON.parse(JSON.parse((await snapshots.read(id, "json")).text!).chunk);
  assert.equal(json.metadata.status, "error");
  assert.match(json.data.attention, /challenge/);
  const tab = browser.tabs[0]!;
  tab.error = new Error("inspection failed");
  tab.captureError = new Error("capture failed");
  tab.screenshotError = new Error("screenshot failed");
  await assert.rejects(research.run("fetch", "https://example.test/", 10), /inspection failed[\s\S]*Snapshot: snap_/);
  assert.equal(tab.navigations, 1);
});

test("real Chromium/Firefox evaluation cancellation closes the research tab; a later call opens a fresh one", { timeout: 90_000 }, async t => {
  const root = await isolateBrokers(t);
  let started!: () => void;
  let ready = new Promise<void>(resolve => { started = resolve; });
  const url = `${await fixtureServer(t, (request, response) => {
    if (request.url === "/started") { started(); response.end(); return; }
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Recovered page</title><main><h1>Recovered page</h1><p>This is the recovered document.</p></main>");
  })}/`;
  for (const engine of ["chromium", "firefox"] as const) {
    await t.test(engine, async t => {
      const client = new BrowserClient({ source: { browser: engine, profileDir: path.join(root, engine), headless: true }, session: "research", idleMs: 300 });
      const research = new BrowserResearch(resolveWebSettings({}, {}), client);
      t.after(async () => { await research.close(); await client.close(); });
      ready = new Promise<void>(resolve => { started = resolve; });
      const evaluate = SharedTab.prototype.evaluate;
      const hung = t.mock.method(SharedTab.prototype, "evaluate", function (this: SharedTab, _expression: string, options?: OperationOptions) {
        hung.mock.restore();
        // The page reports that the evaluation is running before it is cancelled.
        return evaluate.call(this, "fetch('/started').then(() => new Promise(() => {}))", options);
      });
      const controller = new AbortController();
      const cancelled = assert.rejects(research.run("fetch", url, 5, controller.signal), /tab closed to terminate running JavaScript/);
      await ready;
      controller.abort(new Error("cancelled recovery test"));
      await cancelled;
      const messages: string[] = [];
      const recovered = await research.run("fetch", url, 5, undefined, undefined, message => messages.push(message));
      assert.match(recovered.output, /recovered document/);
      assert.ok(messages.some(message => /fresh tab/.test(message)));
      assert.ok(messages.every(message => !/Resuming/.test(message)));
      assert.match(recovered.tab, /^127\.0\.0\.1:\d+$/);
    });
  }
});
