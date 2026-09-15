import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { launchBrowser, type BrowserSession, type BrowserTab } from "../src/core/index.ts";
import { BrowserResearch, WebAttentionRequired } from "../src/web/browser.ts";
import { captureExpression, inspectionExpression, type PageInspection } from "../src/web/extract.ts";
import { createWebTools } from "../src/web/index.ts";
import { CODEX_ENDPOINT } from "../src/web/codex.ts";
import { resolveWebSettings } from "../src/web/settings.ts";

function inspection(patch: Partial<PageInspection> = {}): PageInspection {
  return { url: "https://example.com/", title: "Example", ready: true, noResults: false, results: [], markdown: "# Example\n\nVisible article.", limitations: [], ...patch };
}

test("attention Continue/retry preserves the tab and never repeats navigation; cancellation leaves it intact", async t => {
  let current = inspection({ attention: "Complete the challenge manually." });
  let navigations = 0;
  let closed = false;
  let launches = 0;
  const tab: BrowserTab = {
    id: "owned-tab", closed: false, navigate: async () => { navigations++; }, evaluate: async expression => expression === captureExpression()
      ? { html: "<main>Fixture</main>", md: current.markdown, text: current.markdown, json: { ...current }, warnings: [], capturedAt: new Date().toISOString() }
      : current,
    info: async () => ({ url: current.url, title: current.title }), screenshot: async () => "", html: async () => "", focus: async () => {}, close: async () => {},
  };
  const browser: BrowserSession = { get closed() { return closed; }, openTab: async () => tab, close: async () => { closed = true; } };
  const research = new BrowserResearch(resolveWebSettings({}, {}), async () => { launches++; return browser; });
  t.after(() => research.close());
  await assert.rejects(research.run("fetch", "https://example.com/", 5), WebAttentionRequired);
  assert.equal(navigations, 1);
  current = inspection();
  const resumed = await research.run("fetch", "https://example.com/", 5);
  assert.match(resumed.output, /Visible article/);
  assert.equal(navigations, 1);
  current = inspection({ attention: "Sign in manually." });
  const continued = await research.run("fetch", "https://example.com/second", 5, undefined, async request => {
    assert.equal(request.tabId, "owned-tab");
    assert.ok(request.id);
    current = inspection({ markdown: "User corrected this page.", url: "https://example.com/corrected" });
    return true;
  });
  assert.equal(continued.url, "https://example.com/corrected");
  assert.equal(navigations, 2);
  current = inspection({ attention: "Challenge again." });
  let waiting!: () => void;
  const ready = new Promise<void>(resolve => { waiting = resolve; });
  const abort = new AbortController();
  const pending = research.run("fetch", "https://example.com/cancel", 5, abort.signal, async () => { waiting(); return new Promise<boolean>(() => {}); });
  const rejected = assert.rejects(pending, /cancel attention/);
  await ready;
  abort.abort(new Error("cancel attention"));
  await rejected;
  assert.equal(closed, false);
  assert.equal(launches, 1);
  current = inspection();
  await research.run("fetch", "https://example.com/cancel", 5);
  assert.equal(navigations, 3);
  await research.close();
  assert.equal(closed, true);
});

test("real browser DOM extraction preserves shadow code, links, lists, tables, and engine snippets", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-web-fixture-"));
  const html = `<!doctype html><title>Fixture article</title><nav>Navigation junk</nav><main><h1>Fixture article</h1><p>Read <a href="/reference">the reference</a>.</p><ul><li>First</li><li>Second</li></ul><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>42</td></tr></table><fixture-code><span slot="label">Slotted label</span></fixture-code><script>customElements.define('fixture-code',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<style>pre{color:black}</style><slot name="label"></slot><pre><code class="language-js">const n = 42;\\n\\nconsole.log(n);</code></pre>'.replaceAll('\\\\n','\\n');}});</script><iframe srcdoc="<p>Embedded excluded</p>"></iframe><p hidden>Hidden secret</p></main>`;
  const pages: Record<string, string> = {
    "/article": html,
    "/spa": '<!doctype html><title>SPA fixture</title><main>Loading…</main><script>setTimeout(()=>document.querySelector("main").innerHTML="<h1>Loaded article</h1><p>Delayed rendered content after JavaScript.</p>", 900)</script>',
    "/duckduckgo": '<!doctype html><title>Search</title><article data-testid="result"><h2><a data-testid="result-title-a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First result</a></h2><div data-result="snippet">The first snippet.</div></article><article data-testid="result"><h2><a data-testid="result-title-a" href="https://example.com/a#fragment">Duplicate</a></h2></article><article class="result result--ad"><a class="result__a" href="https://ads.example/">Advertisement</a></article>',
    "/bing": `<!doctype html><title>Search</title><ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${Buffer.from("https://example.com/b").toString("base64url")}">Bing result</a></h2><div class="b_caption"><p>Bing snippet.</p></div></li></ol>`,
    "/brave": '<!doctype html><title>Search</title><div id="results"><div class="snippet" data-type="web"><a class="heading-serpresult" href="https://example.com/c"><div class="title">Brave result</div></a><div class="snippet-description">Brave snippet.</div></div></div>',
    "/empty": '<!doctype html><title>Search</title><main>No results found.</main>',
    "/challenge": '<!doctype html><title>Just a moment</title><main>Please verify you are human.</main>',
  };
  const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(pages[req.url ?? ""] ?? "<!doctype html><title>Blank</title>"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); });
  for (const engine of ["chromium", "firefox"] as const) {
    await t.test(engine, async () => {
      const browser = await launchBrowser({ browser: engine, headless: true, profileDir: path.join(root, engine), ...(engine === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" ? { noSandbox: true } : {}) });
      try {
        const page = await browser.openTab(`${base}/article`);
        const extracted = await page.evaluate(inspectionExpression("fetch", "duckduckgo")) as PageInspection;
        assert.match(extracted.markdown, /# Fixture article/);
        assert.match(extracted.markdown, /const n = 42/);
        assert.match(extracted.markdown, /```js/);
        assert.match(extracted.markdown, /Slotted label/);
        assert.match(extracted.markdown, /\[the reference\]\(<http:\/\/127\.0\.0\.1:/);
        assert.match(extracted.markdown, /- First/);
        assert.match(extracted.markdown, /\| Name \| Value \|/);
        assert.doesNotMatch(extracted.markdown, /Navigation junk|Hidden secret|Embedded excluded|customElements\.define/);
        assert.ok(extracted.limitations.length);
        for (const searchEngine of ["duckduckgo", "bing", "brave"] as const) {
          await page.navigate(`${base}/${searchEngine}`);
          const result = await page.evaluate(inspectionExpression("search", searchEngine)) as PageInspection;
          assert.equal(result.results.length, 1);
          assert.match(result.results[0]!.url, /^https:\/\/example\.com\/[abc]$/);
          assert.match(result.results[0]!.snippet, /snippet/i);
        }
        await page.navigate(`${base}/empty`);
        assert.equal((await page.evaluate(inspectionExpression("search", "bing")) as PageInspection).noResults, true);
        await page.navigate(`${base}/challenge`);
        assert.match((await page.evaluate(inspectionExpression("fetch", "bing")) as PageInspection).attention ?? "", /human verification/);
      } finally { await browser.close(); }
    });
  }
  await t.test("browser-only skips auth, waits for SPA, and auto fallback reports the cause without caching failure", async () => {
    const nativeFetch = globalThis.fetch;
    let status = 503;
    let codexCalls = 0;
    const transport = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== CODEX_ENDPOINT) return nativeFetch(url, init);
      codexCalls++;
      return status === 200 ? Response.json({ output: "Recovered Codex output." }) : new Response("temporarily unavailable", { status });
    });
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
    const ctx = { modelRegistry: { getApiKeyForProvider: async () => token }, model: undefined } as unknown as ExtensionContext;
    const browserOnly = createWebTools({ profileDir: path.join(root, "only"), settings: { backend: "browser", browser: "firefox", headless: true } });
    const auto = createWebTools({ profileDir: path.join(root, "auto"), settings: { backend: "auto", browser: "firefox", headless: true } });
    try {
      const forbidden = { modelRegistry: { getApiKeyForProvider: async () => { throw new Error("auth must not be called"); } }, model: undefined } as unknown as ExtensionContext;
      const spa = await browserOnly.tools[1]!.execute("spa", { url: `${base}/spa` }, undefined, undefined, forbidden);
      assert.equal(spa.details.backend, "browser");
      assert.match(spa.content.map(part => part.type === "text" ? part.text : "").join(""), /Delayed rendered content/);
      assert.equal(codexCalls, 0);
      const progress: string[] = [];
      const fallback = await auto.tools[1]!.execute("fallback", { url: `${base}/article` }, undefined, update => progress.push(JSON.stringify(update.content)), ctx);
      assert.equal(fallback.details.backend, "browser");
      assert.match(fallback.details.fallbackReason ?? "", /503/);
      assert.ok(progress.some(message => /falling back/.test(message)));
      status = 200;
      const recovered = await auto.tools[1]!.execute("recovered", { url: `${base}/article` }, undefined, undefined, ctx);
      assert.equal(recovered.details.backend, "codex");
      assert.equal(codexCalls, 2);
      const missing = { modelRegistry: { getApiKeyForProvider: async () => undefined }, model: undefined } as unknown as ExtensionContext;
      const unauthenticated = await auto.tools[1]!.execute("missing-auth", { url: `${base}/article` }, undefined, undefined, missing);
      assert.equal(unauthenticated.details.backend, "browser");
      assert.match(unauthenticated.details.fallbackReason ?? "", /No OpenAI Codex OAuth/);
      const preAborted = new AbortController();
      preAborted.abort(new Error("already cancelled"));
      await assert.rejects(auto.tools[1]!.execute("aborted", { url: `${base}/article` }, preAborted.signal, undefined, ctx), /already cancelled/);
      assert.equal(codexCalls, 2);
    } finally { transport.mock.restore(); await auto.close(); await browserOnly.close(); }
  });
});
