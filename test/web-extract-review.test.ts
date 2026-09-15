import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { launchBrowser } from "../src/core/index.ts";
import { inspectionExpression, type PageInspection } from "../src/web/extract.ts";

const pages: Record<string, string> = {
  "/roots": '<main hidden>Hidden wrong article</main><main></main><article><h1>Actual article</h1><p>A short but complete article.</p></article>',
  "/loading": '<main aria-busy="true"><h1>Article heading</h1><p>Loading content...</p></main>',
  "/loading-fallback": '<main>Loading…</main><article><p>Ready article outside the empty application shell.</p></article>',
  "/not-loading": '<main><p>Loading files is useful.</p></main>',
  "/shadow": String.raw`<main><review-component><span slot="label">Slotted exactly once</span></review-component></main><script>
    customElements.define('review-component', class extends HTMLElement {
      constructor() { super(); this.attachShadow({mode:'open'}).innerHTML = '<slot name="label"></slot><pre><code class="language-js">const ticks = &#96;&#96;&#96;;\n\n// keep blank line</code></pre><ol start="3"><li>Third<ul><li>Nested</li></ul></li></ol><a href="/source">bracket ](https://evil.example/) &lt;html&gt;</a>'; }
    });
  </script>`,
  "/shadow-challenge": `<main>Article behind the verification.</main><challenge-box></challenge-box><script>document.querySelector('challenge-box').attachShadow({mode:'open'}).innerHTML='<form id="challenge-form"><p>Complete this check</p></form>';</script>`,
  "/shadow-consent": `<main>Article behind consent.</main><consent-box></consent-box><script>document.querySelector('consent-box').attachShadow({mode:'open'}).innerHTML='<div role="dialog" aria-modal="true">Review cookies and privacy choices</div>';</script>`,
  "/hidden-challenge": '<div hidden><form id="challenge-form">Please verify you are human</form></div><main><p>Unblocked article.</p></main>',
  "/challenge-documentation": '<article><h1>CAPTCHA implementation guide</h1><p>Show the message "Please verify you are human" when a challenge is required.</p></article>',
  "/empty-search": '<main>No results found.</main>',
  "/query-search": '<main><h1>Search query: no results found</h1><p>Loading the search results.</p></main>',
  "/article-search": '<main><article><h1>No results found</h1><a href="/help">Troubleshooting search issues</a></article></main>',
  "/huge-pre": `<main><pre>${"x".repeat(800_000)}</pre><p>Never traverse unlimited text.</p></main>`,
  "/ragged-table": `<main><table><tr>${"<td>x</td>".repeat(256)}</tr>${"<tr><td>row</td></tr>".repeat(1200)}</table></main>`,
  "/table-pipes": '<main><table><tr><th>Plain</th><th>Code</th></tr><tr><td>A | B</td><td><code>C | D</code></td></tr></table></main>',
  "/depth": '<main id="root"></main><script>let n=document.querySelector("main");for(let i=0;i<200;i++){let child=document.createElement("div");n.append(child);n=child;}n.textContent="Deep end";</script>',
  "/links": '<main><p><a href="https://safe.example/a%3Eb">close ](https://evil.example/) [next]</a> <a href="javascript:alert(1)">unsafe script link</a></p><p>[fake](https://evil.example/) and &lt;script&gt;literal&lt;/script&gt;</p></main>',
};

test("bounded nonmutating extraction handles composed DOM, root selection and search diagnostics", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-extract-review-"));
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Local extraction fixture</title>${pages[request.url ?? ""] ?? "<main>Missing fixture</main>"}`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  for (const browserKind of ["chromium", "firefox"] as const) {
    await t.test(browserKind, async t => {
      const browser = await launchBrowser({ browser: browserKind, headless: true, profileDir: path.join(root, browserKind),
        ...(browserKind === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" ? { noSandbox: true } : {}) });
      t.after(() => browser.close());
      const tab = await browser.openTab();
      const inspect = async (route: string, kind: "fetch" | "search" = "fetch") => {
        await tab.navigate(base + route);
        return await tab.evaluate(inspectionExpression(kind, "duckduckgo")) as PageInspection;
      };
      await t.test("chooses populated article over empty/loading main without rejecting short prose", async () => {
        assert.match((await inspect("/roots")).markdown, /# Actual article/);
        assert.match((await inspect("/loading-fallback")).markdown, /Ready article outside/);
        assert.equal((await inspect("/loading")).ready, false);
        assert.equal((await inspect("/not-loading")).ready, true);
      });
      await t.test("reads slots, shadow code and lists without changing the source", async () => {
        await tab.navigate(base + "/shadow");
        const before = await tab.evaluate("document.documentElement.outerHTML + document.querySelector('review-component').shadowRoot.innerHTML");
        const result = await tab.evaluate(inspectionExpression("fetch", "bing")) as PageInspection;
        const after = await tab.evaluate("document.documentElement.outerHTML + document.querySelector('review-component').shadowRoot.innerHTML");
        assert.equal(before, after);
        assert.equal(result.markdown.match(/Slotted exactly once/g)?.length, 1);
        assert.match(result.markdown, /~~~js\nconst ticks = ```;\n\n\/\/ keep blank line\n~~~/);
        assert.match(result.markdown, /3\. Third\n  - Nested/);
        assert.match(result.markdown, /\\\]\(https:\/\/evil\.example\/\)/);
      });
      await t.test("detects checks in shadow DOM but not hidden widgets or documentation", async () => {
        assert.match((await inspect("/shadow-challenge")).attention ?? "", /human verification/);
        assert.match((await inspect("/shadow-consent")).attention ?? "", /consent or sign-in/);
        assert.equal((await inspect("/hidden-challenge")).attention, undefined);
        assert.equal((await inspect("/challenge-documentation")).attention, undefined);
      });
      await t.test("requires an explicit empty-results message rather than an echoed query", async () => {
        assert.equal((await inspect("/empty-search", "search")).noResults, true);
        assert.equal((await inspect("/query-search", "search")).noResults, false);
        assert.equal((await inspect("/article-search", "search")).noResults, false);
      });
      await t.test("huge code, ragged tables, and deep DOM stay bounded and report omissions", async () => {
        for (const route of ["/huge-pre", "/ragged-table", "/depth"]) {
          const result = await inspect(route);
          assert.ok(result.markdown.length <= 512 * 1024, `${route} exceeded output bound`);
          assert.ok(result.limitations.some(value => /limit|incomplete/.test(value)), `${route} omitted no limit notice`);
          if (route === "/huge-pre") assert.ok(result.markdown.endsWith("```"), "truncated code keeps its closing fence");
        }
        const table = await inspect("/table-pipes");
        assert.match(table.markdown, /A \\\| B/);
        assert.match(table.markdown, /C \\\| D/);
      });
      await t.test("source brackets cannot escape generated links and unsafe URLs remain text", async () => {
        const result = await inspect("/links");
        assert.match(result.markdown, /\[close \\\]\(https:\/\/evil\.example\/\) \\\[next\\\]\]\(<https:\/\/safe\.example\/a%3Eb>\)/);
        assert.doesNotMatch(result.markdown, /javascript:/);
        assert.match(result.markdown, /\\\[fake\\\]\(https:\/\/evil\.example\/\)/);
      });
    });
  }
});
