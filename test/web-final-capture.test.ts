import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { capturePage, type PageCapture } from "../src/capture.ts";
import type { BrowserTab, OperationOptions } from "../src/core/index.ts";
import { SnapshotStore, type SnapshotInfo } from "../src/snapshots.ts";
import { BrowserResearch, WebAttentionRequired } from "../src/web/browser.ts";
import { captureExpression, inspectionExpression, type PageInspection } from "../src/web/extract.ts";
import { resolveWebSettings } from "../src/web/settings.ts";

const inspect = (patch: Partial<PageInspection> = {}): PageInspection => ({
  url: "https://example.test/polled", title: "Polled page", ready: true, noResults: false,
  results: [], markdown: "Polled content", limitations: [], ...patch,
});
const capture = (inspection: PageInspection): PageCapture => ({
  html: `<main>${inspection.markdown}</main>`, md: inspection.markdown, text: inspection.markdown,
  json: { ...inspection }, warnings: inspection.limitations, capturedAt: new Date().toISOString(),
});

async function fixture(t: TestContext, kind: "search" | "fetch" = "fetch") {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-final-capture-"));
  const snapshots = new SnapshotStore({ directory });
  const state = {
    poll: inspect(), final: inspect({ url: "https://example.test/captured", title: "Captured page", markdown: "Captured content" }),
    captures: 0, screenshots: 0, navigations: 0,
    onCapture: undefined as ((options: OperationOptions) => Promise<PageCapture>) | undefined,
  };
  const tab: BrowserTab = {
    id: "final-capture", closed: false,
    navigate: async () => { state.navigations++; },
    focus: async () => {}, close: async () => {},
    info: async () => { throw new Error("Live metadata must not be read"); },
    html: async () => { throw new Error("Live HTML must not be read"); },
    screenshot: async () => { state.screenshots++; throw new Error("Screenshot deliberately unavailable"); },
    evaluate: async (expression, options = {}) => {
      if (expression === captureExpression(kind, "bing")) {
        state.captures++;
        assert.ok(options.signal, "final capture receives the invocation signal");
        return state.onCapture ? state.onCapture(options) : capture(state.final);
      }
      assert.equal(expression, inspectionExpression(kind, "bing"));
      return state.poll;
    },
  };
  const research = new BrowserResearch(resolveWebSettings({ searchEngine: "bing", headless: true }, {}), async () => ({
    closed: false, openTab: async () => tab, close: async () => {},
  }), snapshots);
  t.after(async () => { await research.close(); await rm(directory, { recursive: true, force: true }); });
  const json = async (snapshot: SnapshotInfo) => JSON.parse(JSON.parse((await snapshots.read(snapshot.id, "json")).text!).chunk);
  return { state, research, snapshots, json, tab };
}

test("final capture supplies changed URL, title and content; screenshot failure is nonfatal", async t => {
  const { state, research, json } = await fixture(t);
  const result = await research.run("fetch", "https://example.test/", 5);
  assert.equal(result.url, state.final.url);
  assert.equal(result.title, state.final.title);
  assert.equal(result.output, state.final.markdown);
  const saved = await json(result.snapshot!);
  assert.equal(saved.metadata.url, state.final.url);
  assert.equal(saved.metadata.title, state.final.title);
  assert.equal(saved.data.url, state.final.url);
  assert.deepEqual(saved.data, state.final);
  assert.match(result.limitations.join(" "), /Screenshot deliberately unavailable/);
  assert.equal(state.captures, 1);
});

test("late challenge requires attention and Continue obtains new capture without stale evidence", async t => {
  const { state, research, json } = await fixture(t);
  state.final = inspect({ url: "https://example.test/challenge", attention: "Late challenge", markdown: "Challenge evidence", limitations: ["Old challenge warning"] });
  let waits = 0;
  const result = await research.run("fetch", "https://example.test/", 5, undefined, async request => {
    waits++;
    assert.equal(request.reason, "Late challenge The research browser is headless: no visible window is available; only a host-provided programmatic intervention can correct this live page.");
    assert.equal(request.url, "https://example.test/challenge");
    state.final = inspect({ url: "https://example.test/corrected", title: "Corrected", markdown: "Fresh corrected evidence" });
    return true;
  });
  assert.equal(waits, 1);
  assert.equal(state.captures, 2);
  assert.equal(state.navigations, 1);
  assert.equal(result.output, "Fresh corrected evidence");
  const saved = await json(result.snapshot!);
  assert.equal(saved.data.attention, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /Old challenge warning|Challenge evidence/);
});

test("late challenge without a handler is an error retaining final challenge diagnostics", async t => {
  const { state, research, json } = await fixture(t);
  state.final = inspect({ url: "https://example.test/challenge", attention: "Late challenge", markdown: "Challenge evidence" });
  let failure: unknown;
  try { await research.run("fetch", "https://example.test/", 5); } catch (error) { failure = error; }
  assert.ok(failure instanceof WebAttentionRequired);
  assert.equal(failure.url, state.final.url);
  assert.ok("snapshot" in failure);
  const saved = await json(failure.snapshot as SnapshotInfo);
  assert.equal(saved.metadata.status, "error");
  assert.equal(saved.metadata.url, state.final.url);
  assert.deepEqual(saved.data, state.final);
  assert.equal(state.captures, 1);
});

test("final loading observation retries capture rather than returning the ready poll", async t => {
  const { state, research } = await fixture(t);
  state.onCapture = async () => capture(state.captures === 1
    ? inspect({ ready: false, markdown: "Loading", url: "https://example.test/loading" })
    : state.final);
  const result = await research.run("fetch", "https://example.test/", 5);
  assert.equal(state.captures, 2);
  assert.equal(result.output, state.final.markdown);
});

test("final unsupported content cannot succeed using a readable poll", async t => {
  const { state, research } = await fixture(t);
  state.final = inspect({ unsupported: "PDF content unavailable", url: "https://example.test/pdf" });
  await assert.rejects(research.run("fetch", "https://example.test/", 5), /PDF content unavailable.*https:\/\/example.test\/pdf/);
  assert.equal(state.captures, 1);
});

test("search evidence and preview use captured results, with all sources saved and preview capped at 20", async t => {
  const { state, research, json, snapshots } = await fixture(t, "search");
  state.poll.results = [{ title: "Stale poll result", url: "https://stale.test/", snippet: "Stale" }];
  state.final.results = Array.from({ length: 35 }, (_, index) => ({ title: `Final source ${index}`, url: `https://source.test/${index}`, snippet: `Final snippet ${index}` }));
  const result = await research.run("search", "query", 100);
  assert.deepEqual(result.results, state.final.results.slice(0, 20));
  assert.equal(result.sourceCount, 35);
  assert.equal(result.url, state.final.url);
  assert.doesNotMatch(result.output, /Stale|Final source 20/);
  assert.deepEqual((await json(result.snapshot!)).data.results, state.final.results);
  assert.match((await snapshots.read(result.snapshot!.id, "md")).text!, /Final source 34/);
});

test("cancelling final capture preserves previous completed evidence and never recaptures", async t => {
  const { state, research, json } = await fixture(t);
  const controller = new AbortController();
  const previous = inspect({ ready: false, url: "https://example.test/previous", title: "Previous observation", markdown: "Previous completed capture" });
  state.onCapture = async options => {
    if (state.captures === 1) return capture(previous);
    return new Promise<PageCapture>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      controller.abort(new Error("cancel final observation"));
    });
  };
  let failure: unknown;
  try { await research.run("fetch", "https://example.test/", 5, controller.signal); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /cancel final observation/);
  assert.ok("snapshot" in failure);
  const saved = await json(failure.snapshot as SnapshotInfo);
  assert.equal(saved.metadata.url, previous.url);
  assert.equal(saved.metadata.title, previous.title);
  assert.deepEqual(saved.data, previous);
  assert.equal(saved.data.markdown, previous.markdown);
  assert.equal(state.captures, 2);
  assert.equal(state.screenshots, 1);
});

test("invalid capture diagnostics fail explicitly instead of silently using poll fields", async t => {
  const { state, research } = await fixture(t);
  state.onCapture = async () => ({ ...capture(state.final), json: {} });
  await assert.rejects(research.run("fetch", "https://example.test/", 5), /inspection returned an invalid result/);
  assert.equal(state.captures, 1);
});

test("capture options preserve default fetch behavior and explicitly select search engine and signal", async t => {
  const { tab, state } = await fixture(t, "search");
  const controller = new AbortController();
  assert.equal(captureExpression(), captureExpression("fetch", "duckduckgo"));
  state.onCapture = async options => {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeoutMs, 1234);
    assert.equal("kind" in options, false);
    assert.equal("engine" in options, false);
    return capture(state.final);
  };
  const result = await capturePage(tab, { kind: "search", engine: "bing", signal: controller.signal, timeoutMs: 1234 });
  assert.equal(result.json.url, state.final.url);
});
