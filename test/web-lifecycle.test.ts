import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { launchBrowser, type BrowserSession, type BrowserTab, type OperationOptions } from "../src/core/index.ts";
import { BrowserResearch, WebAttentionRequired } from "../src/web/browser.ts";
import { captureExpression, type PageInspection } from "../src/web/extract.ts";
import type { PageCapture } from "../src/capture.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { resolveWebSettings } from "../src/web/settings.ts";

class FixtureTab implements BrowserTab {
  readonly id: string;
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
  constructor(id: string) { this.id = id; }
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
  async info() { return { url: "https://example.com/", title: "Fixture" }; }
  async screenshot() {
    this.screenshots++;
    if (this.screenshotError) throw this.screenshotError;
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=";
  }
  async html() { return ""; }
  async focus() { this.focuses++; }
  async close() { this.closed = true; }
}

class FixtureBrowser implements BrowserSession {
  closed = false;
  tabs: FixtureTab[] = [];
  async openTab(): Promise<FixtureTab> {
    assert.equal(this.closed, false);
    const tab = new FixtureTab(`fixture-${this.tabs.length}`);
    this.tabs.push(tab);
    return tab;
  }
  async close() { this.closed = true; await Promise.all(this.tabs.map(tab => tab.close())); }
}

test("closed pending tab is replaced only on the next call, preserving sibling tabs", async t => {
  const browser = new FixtureBrowser();
  let launches = 0;
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => { launches++; return browser; });
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/a", 5), WebAttentionRequired);
  await assert.rejects(research.run("fetch", "https://example.com/b", 5), WebAttentionRequired);
  await browser.tabs[0]!.close();
  const messages: string[] = [];
  await assert.rejects(research.run("fetch", "https://example.com/a", 5, undefined, undefined, message => messages.push(message)), WebAttentionRequired);
  assert.equal(launches, 1);
  assert.equal(browser.tabs.length, 3);
  assert.equal(browser.tabs[1]!.closed, false);
  assert.equal(browser.tabs[2]!.navigations, 1);
  assert.ok(messages.some(message => /fresh tab/.test(message)));
  assert.ok(messages.every(message => !/Resuming/.test(message)));
});

test("closed process releases cached handles and relaunches once on a fresh call", async t => {
  const browsers: FixtureBrowser[] = [];
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => {
    const browser = new FixtureBrowser(); browsers.push(browser); return browser;
  });
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/a", 5), WebAttentionRequired);
  await browsers[0]!.close();
  const messages: string[] = [];
  await assert.rejects(research.run("fetch", "https://example.com/a", 5, undefined, undefined, message => messages.push(message)), WebAttentionRequired);
  assert.equal(browsers.length, 2);
  assert.equal(browsers[1]!.tabs[0]!.navigations, 1);
  assert.ok(messages.some(message => /fresh browser\/tab/.test(message)));
  assert.ok(messages.every(message => !/Resuming/.test(message)));
});

test("each attention wait has a fresh ID, including an unchanged challenge and a later retry", async t => {
  const browser = new FixtureBrowser();
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => browser);
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

test("headless attention reports missing visible window and does not pretend to focus one", async t => {
  const browser = new FixtureBrowser();
  const research = new BrowserResearch(resolveWebSettings({ headless: true }, {}), async () => browser);
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/", 5), /headless; no visible window/);
  let reason = "";
  await assert.rejects(research.run("fetch", "https://example.com/", 5, undefined, async request => { reason = request.reason; return false; }), WebAttentionRequired);
  assert.match(reason, /headless: no visible window/);
  assert.equal(browser.tabs[0]!.focuses, 0);
});

test("research tabs have a hard bound without evicting unfinished attention pages", async t => {
  const browser = new FixtureBrowser();
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => browser);
  t.after(() => research.close());
  for (let index = 0; index < 8; index++) await assert.rejects(research.run("fetch", `https://example.com/${index}`, 5), WebAttentionRequired);
  await assert.rejects(research.run("fetch", "https://example.com/overflow", 5), /All 8 research tabs have unfinished operations/);
  assert.equal(browser.tabs.length, 8);
  assert.ok(browser.tabs.every(tab => !tab.closed));
  // An existing request remains usable even when no new tab can be reserved.
  await assert.rejects(research.run("fetch", "https://example.com/0", 5), WebAttentionRequired);
  assert.equal(browser.tabs[0]!.navigations, 1);
  await browser.tabs[0]!.close();
  await assert.rejects(research.run("fetch", "https://example.com/overflow", 5), WebAttentionRequired);
  assert.equal(browser.tabs.filter(tab => !tab.closed).length, 8);
});

test("completed history is small, while pending pages remain intact", async t => {
  const browser = new FixtureBrowser();
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => browser);
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/pending", 5), WebAttentionRequired);
  for (let index = 0; index < 5; index++) await research.run("fetch", `https://example.com/${index}`, 5, undefined, async () => {
    browser.tabs.at(-1)!.attention = false; return true;
  });
  assert.equal(browser.tabs[0]!.closed, false);
  assert.equal(browser.tabs.filter(tab => !tab.closed).length, 4);
  assert.equal(browser.tabs[1]!.closed, true);
  assert.equal(browser.tabs[2]!.closed, true);
});

test("ordinary errors and progress exceptions are propagated without automatic retries", async t => {
  const browser = new FixtureBrowser();
  let launches = 0;
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => { launches++; return browser; });
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/", 5, undefined, undefined, () => { throw new Error("progress callback failed"); }), /progress callback failed/);
  assert.equal(launches, 0);
  await assert.rejects(research.run("fetch", "https://example.com/", 5), WebAttentionRequired);
  const tab = browser.tabs[0]!;
  tab.error = new Error("ordinary inspection failed");
  await assert.rejects(research.run("fetch", "https://example.com/", 5), /ordinary inspection failed/);
  assert.equal(browser.tabs.length, 1);
  assert.equal(tab.navigations, 1);
  assert.equal(tab.closed, false);
});

test("cancellation during tab creation discards the unvisited tab instead of resuming blank content", async t => {
  const controller = new AbortController();
  const browser = new FixtureBrowser();
  let first = true;
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => ({
    get closed() { return browser.closed; },
    close: () => browser.close(),
    openTab: async () => {
      const tab = await browser.openTab();
      if (first) { first = false; controller.abort(new Error("cancelled while opening")); }
      return tab;
    },
  }));
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/", 5, controller.signal), /cancelled while opening/);
  await assert.rejects(research.run("fetch", "https://example.com/", 5), WebAttentionRequired);
  assert.equal(browser.tabs[0]!.closed, true);
  assert.equal(browser.tabs[0]!.navigations, 0);
  assert.equal(browser.tabs[1]!.navigations, 1);
});

test("queued cancellation saves diagnostics without releasing the active browser queue or mutating its reason", { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-web-queue-"));
  const snapshots = new SnapshotStore({ directory: path.join(directory, "snapshots") });
  const browser = new FixtureBrowser();
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => browser, snapshots);
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
  const browser = new FixtureBrowser();
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => browser, snapshots);
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
  const browser = new FixtureBrowser();
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => browser, snapshots);
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

test("real Chromium/Firefox evaluation cancellation permits a later web call to recover", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-web-recovery-"));
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Recovered page</title><main><h1>Recovered page</h1><p>This is the recovered document.</p></main>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const url = `http://127.0.0.1:${address.port}/`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  for (const engine of ["chromium", "firefox"] as const) {
    await t.test(engine, async () => {
      let launches = 0;
      let hang = true;
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const research = new BrowserResearch(resolveWebSettings({ browser: engine, headless: true, profileDir: path.join(root, engine) }, {}), async options => {
        launches++;
        const browser = await launchBrowser({ ...options, ...(engine === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" ? { noSandbox: true } : {}) });
        return {
          get closed() { return browser.closed; },
          close: () => browser.close(),
          openTab: async input => {
            const tab = await browser.openTab(input);
            return {
              id: tab.id, get closed() { return tab.closed; },
              navigate: (target: string, options?: OperationOptions) => tab.navigate(target, options),
              evaluate: (expression: string, options?: OperationOptions) => {
                if (!hang) return tab.evaluate(expression, options);
                hang = false;
                const pending = tab.evaluate("new Promise(() => {})", options);
                // Ensure the actual evaluation has begun before cancelling.
                setTimeout(started, 100);
                return pending;
              },
              info: () => tab.info(), screenshot: () => tab.screenshot(), html: () => tab.html(), focus: () => tab.focus(), close: () => tab.close(),
            };
          },
        };
      });
      try {
        const controller = new AbortController();
        const pending = research.run("fetch", url, 5, controller.signal);
        const cancelled = assert.rejects(pending, /cancelled recovery test/);
        await ready;
        controller.abort(new Error("cancelled recovery test"));
        await cancelled;
        const messages: string[] = [];
        const recovered = await research.run("fetch", url, 5, undefined, undefined, message => messages.push(message));
        assert.match(recovered.output, /recovered document/);
        assert.ok(messages.some(message => /fresh (?:browser\/)?tab/.test(message)));
        assert.ok(messages.every(message => !/Resuming/.test(message)));
        assert.equal(launches, engine === "firefox" ? 2 : 1);
      } finally { await research.close(); }
    });
  }
});
