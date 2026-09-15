import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { capturePage, type PageCapture } from "../src/capture.ts";
import { launchBrowser, type BrowserTab } from "../src/core/index.ts";
import { inspectionExpression, type PageInspection } from "../src/web/extract.ts";

test("capturePage evaluates once and never obtains HTML, metadata or screenshots separately", async () => {
  const expected: PageCapture = { html: "<body>One state</body>", md: "One state", text: "One state", json: { url: "https://example.test/", title: "One state", ready: true, noResults: false, results: [], markdown: "One state", limitations: [] }, warnings: [], capturedAt: "2026-01-01T00:00:00.000Z" };
  let calls = 0;
  const unexpected = async (): Promise<never> => { throw new Error("Separate observation is forbidden"); };
  const tab: BrowserTab = {
    id: "capture", closed: false, navigate: unexpected, info: unexpected, html: unexpected,
    screenshot: unexpected, focus: unexpected, close: unexpected,
    evaluate: async expression => { calls++; new Script(expression); return expected; },
  };
  assert.equal(await capturePage(tab), expected);
  assert.equal(calls, 1);
});

const pages: Record<string, string> = {
  "/semantic": `<nav><button>Navigation noise</button></nav><main><h1>Observed article</h1>
    <p>A <button>meaningful value</button> and <a href="/api"><code>call(  x  )</code></a>.</p>
    <button aria-label="Copy code">Copy</button><div role="toolbar"><button>Tools noise</button></div>
    <p><a href="/label" aria-label="Accessible destination"><svg></svg></a> <button aria-label="Meaningful action"></button></p>
    <p hidden>Hidden noise</p><p style="display:none">Display noise</p><p style="opacity:0">Transparent noise</p><p style="content-visibility:hidden">Skipped noise</p>
    <details><summary>Closed summary</summary><p>Closed noise</p></details>
    <p><code> x  y </code> <code>\u0060tick\u0060</code></p>
    <pre data-language="typescript"><code><a href="/ignored">const</a>  x = 1;\n\n  next();</code><button aria-label="Copy code">Copy code</button></pre>
    <div class="highlight-source-python"><pre>print(\"hello\")</pre></div>
    <a href="javascript:alert(1)" onclick="alert(2)">Unsafe destination remains text</a>
    <img src="/resource" alt="Diagram description"><input value="Do not retain live values">
    <script>window.captureFixtureLoaded = true;</script></main>`,
  "/tables": `<main><table><caption>Quarterly values</caption><thead>
    <tr><th rowspan="2">Company</th><th colspan="2">2026</th></tr><tr><th>Q1</th><th>Q2</th></tr></thead>
    <tbody><tr><td rowspan="2"><button>Acme</button></td><td><button>12</button><button aria-label="Copy">Copy</button></td><td>13</td></tr><tr><td colspan="2">14</td></tr></tbody></table>
    <table><tr><td>First data row</td><td>1</td></tr><tr><td>Second data row</td><td>2</td></tr></table>
    <table><tr><th>Label</th><th>A</th><th>B</th></tr><tr><td rowspan="0">Shared</td><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table></main>`,
  "/overlap": '<main><table><tr><td>A</td><td rowspan="2">B</td></tr><tr><td colspan="2">Keep this value</td></tr></table></main>',
  "/shadow": `<main><capture-component><span slot="label">Slotted exactly once</span><p>Unassigned noise</p></capture-component></main>
    <script>customElements.define('capture-component',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<h2>Shadow heading</h2><slot name="label"></slot><p><button>Shadow value</button></p><p hidden>Shadow hidden noise</p><a href="/shadow-source">Shadow source</a>';}})</script>`,
  "/challenge": '<main>Underlying article</main><div role="dialog" aria-modal="true">Please verify you are human</div>',
  "/bounded": `<main><pre>${"<&".repeat(400_000)}</pre></main>`,
};

test("capture preserves composed semantics as inert HTML, Markdown, text and structured evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-capture-"));
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Capture fixture</title>${pages[request.url ?? ""] ?? "<main>Resource</main>"}`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  for (const engine of ["chromium", "firefox"] as const) {
    await t.test(engine, async t => {
      const browser = await launchBrowser({ browser: engine, headless: true, profileDir: path.join(root, engine),
        ...(engine === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" ? { noSandbox: true } : {}) });
      t.after(() => browser.close());
      const tab = await browser.openTab();
      const capture = async (route: string) => { await tab.navigate(base + route); return capturePage(tab); };
      await t.test("keeps content buttons, accessible names and code without navigation/copy widgets", async () => {
        const result = await capture("/semantic");
        assert.match(result.md, /A meaningful value and \[`call\(  x  \)`\]/);
        assert.match(result.md, /Accessible destination/);
        assert.match(result.md, /Meaningful action/);
        assert.match(result.md, /`  x  y  `/);
        assert.match(result.md, /`` `tick` ``/);
        assert.match(result.md, /```typescript\nconst  x = 1;\n\n  next\(\);\n```/);
        assert.match(result.md, /```python\nprint\("hello"\)\n```/);
        assert.match(result.md, /Diagram description/);
        assert.doesNotMatch(result.md, /noise|Copy|javascript:|Do not retain/);
        assert.doesNotMatch(result.text, /noise|Copy|Do not retain/);
        assert.match(result.text, /call\(  x  \)/);
        assert.match(result.html, /Content-Security-Policy/);
        assert.doesNotMatch(result.html, /<script|onclick=|javascript:|src=|Do not retain/);
        assert.match(JSON.stringify(result.json.links), /Accessible destination/);
        assert.equal((result.json.capture as { capturedAt: string }).capturedAt, result.capturedAt);
        const inspection = await tab.evaluate(inspectionExpression("fetch", "duckduckgo")) as PageInspection;
        assert.equal(inspection.markdown, result.md);
        assert.ok(!("capture" in inspection), "polling must not serialize artifact HTML");
      });
      await t.test("aligns spans and stacked headers without inventing a header from data", async () => {
        const result = await capture("/tables");
        assert.match(result.md, /\| Company \| 2026 \/ Q1 \| 2026 \/ Q2 \|/);
        assert.match(result.md, /\| Acme \| 12 \| 13 \|/);
        assert.match(result.md, /\| Acme \| 14 \| 14 \|/);
        assert.match(result.md, /\| Column 1 \| Column 2 \|/);
        assert.match(result.md, /\| First data row \| 1 \|/);
        assert.match(result.md, /\| Shared \| 3 \| 4 \|/);
        const tables = result.json.tables as { headerRows: number; cells: { text: string; rowspan: number; colspan: number }[] }[];
        assert.equal(tables[0].headerRows, 2);
        assert.ok(tables[0].cells.some(cell => cell.text === "Acme" && cell.rowspan === 2));
        assert.ok(tables[0].cells.some(cell => cell.text === "14" && cell.colspan === 2));
        assert.doesNotMatch(result.md, /Copy/);
      });
      await t.test("malformed overlapping spans have an explicit nonempty source-row fallback", async () => {
        const result = await capture("/overlap");
        assert.match(result.md, /column alignment unavailable/);
        assert.match(result.md, /Keep this value/);
        assert.ok(result.warnings.some(warning => /overlapping/.test(warning)));
      });
      await t.test("flattens open shadows and slots once without mutating the source", async () => {
        await tab.navigate(base + "/shadow");
        const source = "document.documentElement.outerHTML + document.querySelector('capture-component').shadowRoot.innerHTML";
        const before = await tab.evaluate(source);
        const result = await capturePage(tab);
        assert.equal(await tab.evaluate(source), before);
        for (const content of [result.html, result.md, result.text]) {
          assert.equal(content.match(/Slotted exactly once/g)?.length, 1);
          assert.match(content, /Shadow heading/);
          assert.match(content, /Shadow value/);
          assert.doesNotMatch(content, /Unassigned noise|Shadow hidden noise/);
        }
        assert.match(result.html, /data-pi-shadow-root="open"/);
        assert.match(JSON.stringify(result.json.links), /shadow-source/);
      });
      await t.test("preserves challenge evidence instead of silently producing empty artifacts", async () => {
        const result = await capture("/challenge");
        assert.match(String(result.json.attention), /human verification/);
        assert.match(result.html, /verify you are human/);
        assert.match(result.text, /verify you are human/);
      });
      await t.test("escaped HTML, text and Markdown remain bounded with explicit capture limits", async () => {
        const result = await capture("/bounded");
        assert.ok(result.html.length <= 2 * 1024 * 1024);
        assert.ok(result.text.length <= 512 * 1024);
        assert.ok(result.md.length <= 512 * 1024);
        assert.equal((result.json.capture as { incomplete: boolean }).incomplete, true);
        assert.ok(result.warnings.some(warning => /limit|incomplete/.test(warning)));
        assert.ok(result.html.endsWith("</html>"));
      });
    });
  }
});
