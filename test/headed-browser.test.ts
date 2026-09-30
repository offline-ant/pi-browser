import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createBrowserTool } from "../src/browser-tool.ts";
import { createWebTools } from "../src/web/index.ts";

// Explicitly opt in: opens visible, disposable windows on the host's real display.
// No provider calls, external pages, environment changes, or sandbox opt-outs.
for (const browser of ["firefox", "chromium"] as const) {
  test(`${browser}: headed browser captures and web fetch use the live display`, {
    skip: process.env.PI_BROWSER_LIVE_DISPLAY !== "1", timeout: 60_000,
  }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-headed-browser-"));
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Headed fixture</title><main><h1>Headed fixture</h1><p>Visible browser test document.</p></main>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    const manual = createBrowserTool({ browser, headless: false, profileDir: path.join(root, "manual"), artifactDir: path.join(root, "artifacts") });
    const web = createWebTools({ settings: { backend: "browser", browser, headless: false, profileDir: path.join(root, "research") } });
    t.after(async () => {
      try { await Promise.all([manual.close(), web.close()]); }
      finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
    const ctx = {} as ExtensionToolContext;
    const signal = AbortSignal.timeout(45_000);
    const result = await manual.tool.execute("headed", { url, eval: "({width:innerWidth,height:innerHeight})" }, signal, undefined, ctx);
    assert.equal(result.details.browser, browser);
    assert.equal(result.details.title, "Headed fixture");
    assert.equal(result.details.eval_error, undefined);
    const viewport = result.details.eval_result as { width: number; height: number };
    assert(viewport.width > 0 && viewport.height > 0, "a headed browser must have a nonempty viewport");
    const saved = await manual.snapshots.info(result.details.snapshot);
    for (const file of [saved.paths["before-screenshot"]!, saved.paths.screenshot!]) {
      const png = await readFile(file);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
    }
    const fetched = await web.tools[1]!.execute("fetch", { url }, signal, undefined, ctx);
    assert.equal(fetched.details.browser, browser);
    assert.equal(fetched.details.backend, "browser");
    assert.match(JSON.stringify(fetched.content), /Visible browser test document/);
  });
}
