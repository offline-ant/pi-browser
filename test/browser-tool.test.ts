import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { BrowserClient } from "../src/broker/client.ts";
import { createBrowserTool, type BrowserListDetails, type BrowserResultDetails } from "../src/browser-tool.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { brokerPids, fixtureServer, isolateBrokers } from "./helpers.ts";

const context = {} as ExtensionToolContext;
type Params = Parameters<ReturnType<typeof createBrowserTool>["tool"]["execute"]>[1];

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map(part => part.text ?? "").join("");
}

for (const engine of ["chromium", "firefox"] as const) {
  test(`${engine}: browser tool uses named shared tabs and saves evidence`, { timeout: 90_000 }, async t => {
    const root = await isolateBrokers(t);
    let entered!: () => void;
    let gate: ServerResponse | undefined;
    const gated = new Promise<void>(resolve => { entered = resolve; });
    const origin = await fixtureServer(t, (request, response) => {
      if (request.url === "/gate") { gate = response; entered(); return; }
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end(`<!doctype html><title>${request.url}</title><main>Original fixture</main>`);
    });
    t.after(() => { gate?.end(); });
    const source = { browser: engine, profileDir: path.join(root, "profile"), headless: true };
    const client = new BrowserClient({ source, session: "A", idleMs: 300 });
    const other = new BrowserClient({ source, session: "B", idleMs: 300 });
    t.after(() => Promise.all([client.close(), other.close()]));
    const snapshots = new SnapshotStore({ directory: path.join(root, "snapshots") });
    const set = createBrowserTool({ browser: () => client, snapshots });
    const execute = (params: Params, signal?: AbortSignal) => set.tool.execute("test", params, signal, undefined, context);
    const page = async (params: Params, signal?: AbortSignal) => (await execute(params, signal)) as { content: { type: string; text?: string }[]; details: BrowserResultDetails };

    assert(Check(set.tool.parameters, { tab: "docs", url: origin, eval: "1" }));
    assert(Check(set.tool.parameters, { list: true }));
    for (const params of [{ browser: engine }, { remote: "desk" }, { session_id: "default" }]) assert(!Check(set.tool.parameters, params));
    for (const params of [{ url: "file:///etc/passwd" }, { url: "https://user:pass@example.com" }]) await assert.rejects(execute(params), /HTTP\(S\) without embedded credentials/);
    await assert.rejects(execute({ list: true, tab: "docs" }), /list cannot be combined/);
    assert.deepEqual(await brokerPids(root), [], "invalid calls start no browser");
    await assert.rejects(execute({ eval: "1" }), /This session has no tab yet/);

    const first = await page({ url: `${origin}/one?x=1`, eval: "document.querySelector('main').textContent = 'Edited fixture'" });
    const name = `127.0.0.1:${new URL(origin).port}+7`;
    assert.equal(first.details.tab, name);
    assert.equal(first.details.browser, engine);
    assert.equal(first.details.url, `${origin}/one?x=1`);
    assert.match(text(first), new RegExp(`Tab: ${name.replaceAll(".", "\\.").replace("+", "\\+")} \\(new\\) in ${engine}`));
    assert.match(text(first), new RegExp(`Page: /one\\?x=1 — ${origin}/one\\?x=1`.replaceAll("/", "\\/")));
    const saved = await snapshots.info(first.details.snapshot);
    assert.deepEqual(saved.available, ["md", "text", "html", "json", "screenshot", "before-screenshot"]);
    assert.match(await readFile(saved.paths.html!, "utf8"), /Edited fixture/);
    assert.doesNotMatch(text(first), /\/tmp\//);
    for (const file of Object.values(saved.paths)) assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual([...(await readFile(saved.paths.screenshot!)).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const same = await page({ eval: "document.querySelector('main').textContent" });
    assert.equal(same.details.eval_result, "Edited fixture", "an omitted tab is this session's last tab");
    assert.doesNotMatch(text(same), /\(new\)/);
    const thrown = await page({ eval: "(() => { throw new Error('fixture eval failure'); })()" });
    assert.match(thrown.details.eval_error ?? "", /fixture eval failure/);
    assert.equal(thrown.details.tab, name, "ordinary eval errors keep the tab");
    for (const expression of ["'x'.repeat(60 * 1024)", "Array.from({ length: 2200 }, (_, i) => i)"]) {
      const result = await page({ eval: expression });
      assert.equal(result.details.truncated, true);
      assert.match(text(result), /preview truncated; full captured result/);
      assert(Buffer.byteLength(text(result)) < 9 * 1024);
      const json = JSON.parse(await readFile((await snapshots.info(result.details.snapshot)).paths.json!, "utf8"));
      assert.deepEqual(json.metadata.eval_result, expression.startsWith("'x'") ? "x".repeat(60 * 1024) : Array.from({ length: 2200 }, (_, i) => i));
      assert.equal(result.details.eval_result, undefined, "large results are not duplicated in details");
    }

    await assert.rejects(execute({ tab: "docs" }), /Unknown tab "docs"/);
    const docs = await page({ tab: "docs", url: `${origin}/docs`, eval: "document.title" });
    assert.deepEqual([docs.details.tab, docs.details.eval_result], ["docs", "/docs"]);
    assert.equal((await page({ eval: "document.title" })).details.tab, "docs", "the newest tab becomes the default");
    const back = await page({ tab: name, eval: "location.search" });
    assert.equal(back.details.eval_result, "?x=1");

    // Another session may use any tab; this session's next call is warned.
    const { tab } = await other.open({ tab: name });
    await tab.evaluate("document.title = 'changed by B'");
    await tab.release();
    const warned = await page({ eval: "document.title" });
    assert.equal(warned.details.eval_result, "changed by B");
    assert.match(warned.details.warnings?.[0] ?? "", /used by session B/);
    assert.match(text(warned), /Warning: Tab .* was used by session B/);

    const listed = await execute({ list: true });
    const tabs = (listed.details as BrowserListDetails).tabs;
    assert.deepEqual(tabs.map(tab => tab.name).sort(), ["docs", name].sort());
    assert.match(text(listed), new RegExp(`^\\* ${name.replaceAll(".", "\\.").replace("+", "\\+")} — changed by B — ${origin}/one\\?x=1 — last used by this session`, "m"));
    assert.match(text(listed), /^ {2}docs — \/docs — .* — last used by this session at /m);

    // Interrupting a running evaluation closes only its tab and saves pre-eval evidence.
    const abort = new AbortController();
    const interrupted = execute({ eval: "fetch('/gate').then(() => 'must not finish')" }, abort.signal);
    let snapshot = "";
    const rejected = assert.rejects(interrupted, (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /tab closed to terminate running JavaScript/);
      snapshot = /Snapshot: (snap_[a-f0-9]{32})/.exec(error.message)?.[1] ?? "";
      return true;
    });
    await gated;
    abort.abort(new Error("fixture cancellation"));
    await rejected;
    const interruptedInfo = await snapshots.info(snapshot);
    assert(interruptedInfo.available.includes("before-screenshot"));
    assert(!interruptedInfo.available.includes("screenshot"), "cancelled eval must not capture a fake final image");
    assert.equal((await page({ tab: "docs", eval: "document.title" })).details.eval_result, "/docs", "other tabs remain");
    await assert.rejects(execute({ tab: name }), /Unknown tab/);
  });
}

test("a closed last tab without a url is an error; with a url a new tab opens and says so", { timeout: 60_000 }, async t => {
  const root = await isolateBrokers(t);
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const origin = await fixtureServer(t, (request, response) => {
    if (request.url === "/started") started();
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>${request.url}</title>`);
  });
  const client = new BrowserClient({ source: { browser: "chromium", profileDir: path.join(root, "profile"), headless: true }, session: "A", idleMs: 300 });
  t.after(() => client.close());
  const set = createBrowserTool({ browser: () => client, snapshots: new SnapshotStore({ directory: path.join(root, "snapshots") }) });
  const execute = (params: Params, signal?: AbortSignal) => set.tool.execute("test", params, signal, undefined, context);
  await execute({ tab: "only", url: `${origin}/first` });
  const abort = new AbortController();
  const hung = assert.rejects(execute({ eval: "fetch('/started').then(() => new Promise(() => {}))" }, abort.signal), /tab closed/);
  await running;
  abort.abort();
  await hung;
  await assert.rejects(execute({ eval: "document.title" }), /Your last tab "only" was closed\. Give a url/);
  const reopened = await execute({ url: `${origin}/second`, eval: "document.title" });
  assert.match(text(reopened), /Warning: Your last tab "only" was closed; opened a new tab\./);
  assert.equal((reopened.details as BrowserResultDetails).eval_result, "/second");
  assert.match(text(reopened), /\(new\)/);
});

for (const engine of ["chromium", "firefox"] as const) {
  test(`${engine}: concurrent calls on one tab from two sessions run whole calls in turn`, { timeout: 60_000 }, async t => {
    const root = await isolateBrokers(t);
    const origin = await fixtureServer(t, (request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>${request.url}</title><main>Fixture</main>`);
    });
    const source = { browser: engine, profileDir: path.join(root, "profile"), headless: true };
    const snapshots = new SnapshotStore({ directory: path.join(root, "snapshots") });
    const sessions = ["A", "B"].map(session => {
      const client = new BrowserClient({ source, session, idleMs: 300 });
      t.after(() => client.close());
      const set = createBrowserTool({ browser: () => client, snapshots });
      return async (params: Params, signal?: AbortSignal) =>
        (await set.tool.execute("test", params, signal, undefined, context)) as { content: { type: string; text?: string }[]; details: BrowserResultDetails };
    });
    const [a, b] = sessions as [typeof sessions[0], typeof sessions[0]];
    await a({ tab: "shared", url: `${origin}/shared` });
    // Each call logs its start and end with a pause between, then labels the page; its capture follows.
    const step = (label: string) => `(async () => { (window.log ??= []).push('${label}-start'); await new Promise(r => setTimeout(r, 400)); window.log.push('${label}-end'); document.title = window.log.join(','); return window.log.join(','); })()`;
    const first = a({ tab: "shared", eval: step("A") });
    await new Promise(resolve => setTimeout(resolve, 100));
    const cancel = new AbortController();
    const cancelled = assert.rejects(a({ tab: "shared", eval: step("C") }, cancel.signal), /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 100));
    // B navigates: interleaved, its navigation would replace the page before A's final capture.
    const second = b({ tab: "shared", url: `${origin}/b`, eval: step("B") });
    cancel.abort(new Error("waiting call cancelled"));
    await cancelled;
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual([one.details.eval_result, one.details.title, one.details.url], ["A-start,A-end", "A-start,A-end", `${origin}/shared`],
      "the holder's capture precedes the next call, and the cancelled waiter neither ran nor released it");
    assert.deepEqual([two.details.eval_result, two.details.title, two.details.url], ["B-start,B-end", "B-start,B-end", `${origin}/b`]);
  });
}
