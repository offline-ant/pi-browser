import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "../src/broker/client.ts";
import { createBrowserTool, type BrowserResultDetails } from "../src/browser-tool.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { createWebTools } from "../src/web/index.ts";
import { fixtureServer, isolateBrokers } from "./helpers.ts";

// Explicitly opt in: opens visible, disposable windows on the host's real display.
// No provider calls, external pages, environment changes, or sandbox opt-outs.
for (const browser of ["firefox", "chromium"] as const) {
  test(`${browser}: headed browser captures and web fetch share the live display's window`, {
    skip: process.env.PI_BROWSER_LIVE_DISPLAY !== "1", timeout: 60_000,
  }, async t => {
    const root = await isolateBrokers(t);
    const url = `${await fixtureServer(t, (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Headed fixture</title><main><h1>Headed fixture</h1><p>Visible browser test document.</p></main>");
    })}/`;
    const client = new BrowserClient({ source: { browser, profileDir: path.join(root, "profile"), headless: false }, session: "headed", idleMs: 300 });
    const snapshots = new SnapshotStore({ directory: path.join(root, "snapshots") });
    const manual = createBrowserTool({ browser: () => client, snapshots });
    const web = createWebTools({ snapshots, browser: () => client, settings: { backend: "browser" } });
    t.after(async () => { await web.close(); await client.close(); });
    const ctx = {} as ExtensionToolContext;
    const signal = AbortSignal.timeout(45_000);
    const result = (await manual.tool.execute("headed", { url, eval: "({width:innerWidth,height:innerHeight})" }, signal, undefined, ctx)).details as BrowserResultDetails;
    assert.equal(result.browser, browser);
    assert.equal(result.title, "Headed fixture");
    assert.equal(result.eval_error, undefined);
    const viewport = result.eval_result as { width: number; height: number };
    assert(viewport.width > 0 && viewport.height > 0, "a headed browser must have a nonempty viewport");
    const saved = await snapshots.info(result.snapshot);
    for (const file of [saved.paths["before-screenshot"]!, saved.paths.screenshot!]) {
      const png = await readFile(file);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
    }
    const fetched = await web.tools[1]!.execute("fetch", { url }, signal, undefined, ctx);
    assert.equal(fetched.details.backend, "browser");
    assert.match(JSON.stringify(fetched.content), /Visible browser test document/);
    const followUp = (await manual.tool.execute("follow", { tab: fetched.details.tab, eval: "document.title" }, signal, undefined, ctx)).details as BrowserResultDetails;
    assert.equal(followUp.eval_result, "Headed fixture", "research tabs are usable by the browser tool");
  });
}
