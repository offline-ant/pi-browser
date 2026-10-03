import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { tabName } from "../src/broker/broker.ts";
import { BrowserClient, BrowserUnavailable } from "../src/broker/client.ts";
import { processAlive } from "../src/broker/protocol.ts";
import { Cdp } from "../src/core/cdp.ts";
import { brokerPids, fixtureServer, htmlPage, isolateBrokers, waitFor } from "./helpers.ts";

test("tab names: host without www plus the length of everything after it", () => {
  assert.equal(tabName("https://www.google.com/search"), "google.com+6");
  assert.equal(tabName("https://www.google.com/search?q=pi"), "google.com+11");
  assert.equal(tabName("https://google.com/"), "google.com");
  assert.equal(tabName("https://test.example.com"), "test.example.com");
  assert.equal(tabName("http://127.0.0.1:8080/a#b"), "127.0.0.1:8080+3");
  assert.equal(tabName("https://wwwexample.com/"), "wwwexample.com");
  assert.equal(tabName("about:blank"), "about+5");
  assert.equal(tabName("not a url"), "tab");
});

async function ownerOf(profileDir: string): Promise<{ pid: number; browserPid: number }> {
  return JSON.parse(await readFile(path.join(profileDir, ".pi-browser-owner", "owner.json"), "utf8"));
}

for (const engine of ["chromium", "firefox"] as const) {
  test(`${engine}: sessions share one broker, named tabs, recent lists and idle exit`, { timeout: 120_000 }, async t => {
    const root = await isolateBrokers(t);
    let started!: () => void;
    const startedRequest = new Promise<void>(resolve => { started = resolve; });
    const origin = await fixtureServer(t, (request, response) => {
      if (request.url === "/started") started();
      htmlPage(request, response);
    });
    const port = new URL(origin).port;
    const profileDir = path.join(root, "profile");
    await mkdir(profileDir, { mode: 0o700 });
    // Lets a page open a "human" tab in this disposable Firefox profile only.
    if (engine === "firefox") await writeFile(path.join(profileDir, "user.js"), 'user_pref("dom.disable_open_during_load", false);\n');
    const source = { browser: engine, profileDir, headless: true };
    const a = new BrowserClient({ source, session: "A", idleMs: 300 });
    const b = new BrowserClient({ source, session: "B", idleMs: 300 });
    t.after(() => Promise.all([a.close(), b.close()]));

    // Concurrent first use from two sessions still starts exactly one broker and browser.
    const [first, docs] = await Promise.all([a.open({ url: `${origin}/search?q=1` }), b.open({ tab: "docs", url: `${origin}/docs` })]);
    assert.equal((await brokerPids(root)).length, 1);
    const firstName = `127.0.0.1:${port}+10`;
    assert.equal(first.tab.name, firstName);
    assert.deepEqual([first.created, first.browser, first.warnings], [true, engine, []]);
    assert.equal(docs.tab.name, "docs");
    await first.tab.navigate(`${origin}/search?q=1`);
    await docs.tab.navigate(`${origin}/docs`);
    await Promise.all([first.tab.release(), docs.tab.release()]);
    const browserPid = (await ownerOf(profileDir)).browserPid;

    await assert.rejects(a.open({ tab: "missing" }), /Unknown tab "missing"/);
    await assert.rejects(a.open({ tab: "has space", url: origin }), /without whitespace/);
    const again = await a.open({});
    assert.equal(again.tab.id, first.tab.id, "an omitted tab is the session's last tab");
    assert.equal(again.created, false);
    assert.equal(await again.tab.evaluate("location.pathname + location.search"), "/search?q=1");
    await again.tab.release();
    const other = await a.open({ url: `${origin}/other` });
    assert.equal(other.tab.id, first.tab.id, "a url alone navigates the last tab, not a new one");
    await other.tab.release();

    const shared = await b.open({ tab: firstName });
    assert.deepEqual(shared.warnings, [], "first use by another session is not a conflict");
    assert.equal(await shared.tab.evaluate("document.title"), "/search?q=1");
    await shared.tab.release();
    const warned = await a.open({});
    assert.equal(warned.warnings.length, 1);
    assert.match(warned.warnings[0]!, /was used by session B at .* since this session last used it/);
    await warned.tab.release();
    const unwarned = await a.open({});
    assert.deepEqual(unwarned.warnings, []);
    await unwarned.tab.release();

    const listed = await a.list();
    const mine = listed.find(tab => tab.name === firstName)!;
    assert.deepEqual([mine.url, mine.title, mine.openedBy, mine.current, mine.lastSession], [`${origin}/search?q=1`, "/search?q=1", "broker", true, "this session"]);
    const theirs = listed.find(tab => tab.name === "docs")!;
    assert.deepEqual([theirs.url, theirs.title, theirs.current, theirs.lastSession], [`${origin}/docs`, "/docs", false, "B"]);
    assert(Number.isFinite(Date.parse(theirs.lastUsedAt!)));
    assert.equal((await b.list()).find(tab => tab.name === firstName)!.lastSession, "A");

    const duplicate = await a.open({ create: true, url: `${origin}/search?q=1` });
    assert.equal(duplicate.tab.name, `127.0.0.1:${port}+10-2`, "automatic names are unique");
    await duplicate.tab.release();

    // A call holds its tab until release: the same tab from another session waits; a cancelled waiter releases nothing.
    const holder = await a.open({ tab: firstName });
    await holder.tab.evaluate("window.order = ['A1']");
    const cancel = new AbortController();
    const cancelled = a.open({ tab: firstName }, cancel.signal);
    await delay(100);
    let waited = false;
    const waiter = b.open({ tab: firstName }).then(result => { waited = true; return result; });
    await delay(100);
    cancel.abort(new Error("waiter cancelled"));
    await assert.rejects(cancelled, /cancelled/);
    const elsewhere = await b.open({ tab: "docs" });
    assert.equal(await elsewhere.tab.evaluate("document.title"), "/docs", "other tabs stay usable meanwhile");
    await elsewhere.tab.release();
    await delay(200);
    await holder.tab.evaluate("window.order.push('A2')");
    assert.equal(waited, false, "the waiter cannot use the tab before the holder releases it");
    await holder.tab.release();
    const next = await waiter;
    assert.deepEqual(await next.tab.evaluate("window.order"), ["A1", "A2"]);
    await next.tab.release();

    // Interrupting a running evaluation closes only that tab.
    const running = await b.open({ tab: "docs" });
    const controller = new AbortController();
    const hung = running.tab.evaluate("fetch('/started').then(() => new Promise(() => {}))", { signal: controller.signal, timeoutMs: 20_000 });
    await startedRequest;
    controller.abort();
    await assert.rejects(hung, /tab closed to terminate running JavaScript/);
    assert.equal(running.tab.closed, true);
    await running.tab.release();
    const survivor = await a.open({ tab: firstName });
    assert.equal(await survivor.tab.evaluate("1 + 1"), 2);
    await assert.rejects(b.open({}), /Your last tab "docs" was closed\. Give a url/);
    const replacement = await b.open({ url: `${origin}/replacement` });
    assert.equal(replacement.created, true);
    assert.equal(replacement.tab.name, `127.0.0.1:${port}+11`);
    assert.match(replacement.warnings[0]!, /Your last tab "docs" was closed; opened a new tab/);
    await replacement.tab.release();

    // A tab opened outside Pi is discovered, named, usable, and never closed automatically.
    if (engine === "chromium") {
      const [portText, socketPath] = (await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).trim().split("\n");
      const human = await Cdp.connect(`ws://127.0.0.1:${portText}${socketPath}`);
      try { await human.request("Target.createTarget", { url: `${origin}/human` }); } finally { human.close(); }
    } else assert.equal(await survivor.tab.evaluate(`String(!!window.open(${JSON.stringify(`${origin}/human`)}, "_blank"))`), "true");
    await survivor.tab.release();
    await waitFor(async () => (await a.list()).some(tab => tab.url === `${origin}/human`), 10_000, "the human tab");
    const human = (await a.list()).find(tab => tab.url === `${origin}/human`)!;
    assert.equal(human.openedBy, "other");
    assert.equal(human.lastSession, undefined);

    // Ten more tabs push A's older tabs out of its recent list; the next check closes
    // broker-opened tabs in no session's list, keeping B's and the human tab.
    for (let index = 1; index <= 10; index++) await (await a.open({ tab: `l${index}`, url: `${origin}/l${index}` })).tab.release();
    let names = (await a.list()).map(tab => tab.name);
    for (let index = 1; index <= 10; index++) assert(names.includes(`l${index}`));
    assert(!names.includes(duplicate.tab.name), "A's evicted tab closed");
    assert(names.includes(firstName), "still in B's recent list");
    assert(names.includes(replacement.tab.name));
    assert(names.includes(human.name));

    // Disconnecting B is also a check: its tabs leave every list and close.
    await b.close();
    await waitFor(async () => !(await a.list()).some(tab => tab.name === firstName), 5_000, "B's tabs to close");
    names = (await a.list()).map(tab => tab.name);
    assert(!names.includes(replacement.tab.name));
    assert(names.includes(human.name), "human tabs are never closed automatically");
    const humanTab = await a.open({ tab: human.name });
    assert.equal(await humanTab.tab.evaluate("location.pathname"), "/human");
    await humanTab.tab.release();

    // A different headless setting is refused rather than starting a second browser.
    const headed = new BrowserClient({ source: { ...source, headless: false }, session: "C" });
    await assert.rejects(headed.open({}), /started headless by another session/);
    await headed.close();

    // The broker exits after its idle period, closing the browser and releasing the profile.
    const [brokerPid] = await brokerPids(root);
    await a.close();
    await waitFor(() => !processAlive(brokerPid) && !processAlive(browserPid), 15_000, "broker and browser exit");
    await assert.rejects(stat(path.join(profileDir, ".pi-browser-owner")), { code: "ENOENT" });
    assert.deepEqual((await brokerPids(root)), []);
  });
}

test("a dead broker's socket is taken over; its live browser keeps the profile until it is gone", { timeout: 90_000 }, async t => {
  const root = await isolateBrokers(t);
  const origin = await fixtureServer(t, htmlPage);
  const profileDir = path.join(root, "profile");
  const client = new BrowserClient({ source: { browser: "chromium", profileDir, headless: true }, session: "A", idleMs: 300 });
  t.after(() => client.close());
  const { tab } = await client.open({ url: `${origin}/before` });
  const [brokerPid] = await brokerPids(root);
  const { browserPid } = await ownerOf(profileDir);
  t.after(() => { try { process.kill(-browserPid, "SIGKILL"); } catch { /* Already gone. */ } });
  process.kill(brokerPid!, "SIGKILL");
  await waitFor(() => tab.closed, 5_000, "the client to notice the disconnect");
  await assert.rejects(client.open({ url: `${origin}/blocked` }), (error: unknown) => {
    assert(error instanceof BrowserUnavailable);
    assert.match(error.message, /already owned/);
    return true;
  });
  const [replacement] = await brokerPids(root);
  assert.notEqual(replacement, brokerPid, "the stale socket and record were taken over");
  assert(processAlive(replacement));
  process.kill(-browserPid, "SIGKILL");
  await waitFor(() => !processAlive(browserPid), 5_000, "the orphaned browser to stop");
  const reopened = await client.open({ url: `${origin}/after` });
  assert.equal(reopened.created, true);
  await reopened.tab.navigate(`${origin}/after`);
  assert.equal(await reopened.tab.evaluate("document.title"), "/after");
  assert.notEqual((await ownerOf(profileDir)).browserPid, browserPid);
});
