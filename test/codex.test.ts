import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCodex, type CodexResponse } from "../src/web/codex.ts";

const cite = (ref: string) => `\uE200cite\uE202${ref}\uE201`;
const source = (index: number, url = `https://example.test/article/${index}`) => ({
  type: "text_result", domain: "example.test", ref_id: `turn0search${index}`, title: `Article ${index}`, url,
  snippet: `Source excerpt ${index}. ${"Long excerpt ".repeat(60)}`, thumbnail_url: "https://example.test/thumbnail.png",
});
function fetchResponse(lines: string[], title = "Article - Reference | Example"): CodexResponse {
  return {
    encrypted_output: "synthetic opaque output",
    output: `${title} (https://example.test/article)\n${cite("turn0view0")} [wordlim: 200] Crawled: today; Content type: text/html; Source: open({"ref_id":"https://example.test/article","lineno":null}); Total lines: ${lines.length}\n${lines.map((line, index) => `L${index}: ${line}`).join("\n")}`,
    results: [{ ...source(0, "https://example.test/article"), title, ref_id: "turn0view0", snippet: `Total lines: ${lines.length}` }],
  };
}

test("actual Codex wire shape uses structured search results, not citation-delimited article dumps", () => {
  const results = Array.from({ length: 32 }, (_, index) => source(index));
  const response = { encrypted_output: "synthetic opaque output", results,
    output: results.map(result => `${result.title} (${result.url})\n${cite(result.ref_id)} [wordlim: 200] Crawled: today;\n# Article dump\nLong raw page body`).join("\n" + "-".repeat(80) + "\n") };
  for (const count of [1, 10, 20]) {
    const content = formatCodex("search", response, count);
    assert.equal(content.sourceCount, 32);
    assert.equal(content.returnedCount, count);
    assert.equal(content.results?.length, 32);
    assert.equal(content.preview.match(/^\d+\. /gm)?.length, count);
    assert.match(content.md, /Article 31/);
    assert.doesNotMatch(content.preview, /Article dump|raw page body|turn0search|synthetic opaque/);
    assert.ok(Buffer.byteLength(content.preview) < 16 * 1024);
    assert.deepEqual(content.warnings, []);
    assert.match(content.text!, /^1\. Article 0\nhttps:\/\/example.test\/article\/0/);
  }
});

test("search deduplication ignores only fragments, retaining query values, ordering, mirrors and source references", () => {
  const urls = ["https://EXAMPLE.test:443/a?q=1#first", "https://example.test/a?q=1#second", "https://example.test/a?q=2",
    "https://example.test/a?q=1&x=2", "https://example.test/a?x=2&q=1", "https://mirror.test/a?q=1", "https://example.test/a", "https://example.test/a/"];
  const response = { output: "raw", results: urls.map((url, index) => source(index, url)) };
  const original = JSON.stringify(response);
  const content = formatCodex("search", response, 20);
  assert.equal(content.sourceCount, 8);
  assert.equal(content.returnedCount, 7);
  assert.equal(content.results?.[0]?.url, "https://example.test/a?q=1#first");
  assert.deepEqual(content.results?.slice(1).map(result => result.url), urls.slice(2));
  assert.match(content.warnings.join(" "), /1 duplicate.*fragments only/);
  assert.equal(JSON.stringify(response), original, "normalization never mutates raw results or reference IDs");
});

test("missing or malformed structured search arrays explicitly retain raw output and unknown counts", () => {
  const output = `Article (https://example.test/article)\n${cite("turn0search0")} [wordlim: 200]\nA convincing but non-authoritative header`;
  for (const results of [undefined, null, {}, [source(0), null], [{ ...source(0), type: "image_result" }], [{ ...source(0), ref_id: "" }],
    [{ ...source(0), domain: 1 }], [{ ...source(0), snippet: null }], [{ ...source(0), title: "" }],
    [{ ...source(0), url: "https://user:password@example.test/" }], [{ ...source(0), url: "javascript:alert(1)" }]]) {
    const content = formatCodex("search", { output, results }, 1);
    assert.equal(content.preview, output);
    assert.equal(content.md, output);
    assert.equal(content.sourceCount, undefined);
    assert.equal(content.returnedCount, undefined);
    assert.match(content.warnings.join(" "), /structured results.*raw preview.*count is unknown/);
  }
  const empty = formatCodex("search", { output: "No matches.", results: [] }, 10);
  assert.equal(empty.sourceCount, 0);
  assert.equal(empty.returnedCount, 0);
  assert.deepEqual(empty.warnings, []);
});

test("live-style joined line wrappers preserve labels, strip confirmed preamble and fence exact provider code", () => {
  const code = ['const value = `L123: literal`;', `  const label = '${cite("1†literal code label")} L124: literal';`, "", 'console.log("```");'];
  const response = fetchResponse([
    `  * ${cite("0†Skip to main content")}`, `  * ${cite("1†Skip to search")}`, "", "Reference", `${cite("2†All topics")}`,
    "# Article", "", `See \`value\`, ${cite("3†iterable")}, ${cite("4†`Array`")}, ${cite("5†External†example.org")}, and ${cite("unknown†`opaque`")}.`,
    `## ${cite("6†Example")}`, "", `    \`${code[0]}`, ...code.slice(1).map(line => line ? `    ${line}` : ""), "    `", "",
    `## ${cite("7†See also")}`, `  * ${cite("8†Related item")}`, `    1. ${cite("9†Nested item")}`, `    2. ${cite("10†Another item")}`, "",
    "Footer retained without a confirmed boundary.",
  ]);
  // The actual wire joins the next wrapper after a citation, even for nested lists and headings.
  response.output = response.output.replace(/()\n(L\d+:)/g, "$1 $2");
  const original = JSON.stringify(response);
  const content = formatCodex("fetch", response, 10);
  assert.match(content.md, /^# Article\n/);
  assert.match(content.md, /See `value`, iterable, `Array`, External, and citeunknown†`opaque`\./);
  assert.match(content.md, /## Example\n/);
  assert.ok(content.md.includes(`\n\`\`\`\`\n${code.join("\n")}\n\`\`\`\`\n`));
  assert.ok(content.text?.includes(code.join("\n")));
  assert.ok(content.text?.includes(cite("unknown†`opaque`")));
  assert.match(content.text!, /^Article\n/);
  assert.match(content.md, /Footer retained/);
  assert.doesNotMatch(content.md, /Skip to|L0:|L5:|https:\/\/example.org/);
  assert.match(content.warnings.join(" "), /Omitted 5 preamble lines.*unknown references/);
  assert.equal(JSON.stringify(response), original);
});

test("fetch leaves ambiguous wrappers, code, references and article selection untouched", () => {
  const lines = ["Introductory prose stays.", "# Article", `Prose L123: is not a wrapper. ${cite("turn0view0")}`,
    `\`${cite("1†inline code")} L4: literal\``, "```js", `const literal = '${cite("2†fenced code")} L6: literal';`, "L123: literal prefix", "```",
    "    `truncated provider code", "    L123: literal", "", "A paragraph ends the indented block.",
    "    `ordinary inline span`", "    continuation", "    `", `Unknown ${cite("not-a-label")} and 【unknown】.`, "[Real link](https://example.test/real)"];
  const content = formatCodex("fetch", fetchResponse(lines), 10);
  assert.equal(content.md, lines.join("\n"));
  assert.ok(content.text?.includes(`const literal = '${cite("2†fenced code")} L6: literal';`));
  assert.match(content.text!, /Real link \(https:\/\/example.test\/real\)/);
  for (const title of ["Other title", "ArticleExtra"]) {
    const response = fetchResponse([cite("0†Skip to main content"), "# Article", "Body"], title);
    assert.match(formatCodex("fetch", response, 10).md, /^Skip to main content\n# Article/);
  }
  for (const replacement of ["unrecognized:", "L400:"]) {
    const response = fetchResponse(lines);
    response.output = response.output.replace("\nL4:", `\n${replacement}`);
    const raw = formatCodex("fetch", response, 10);
    assert.equal(raw.md, response.output);
    assert.match(raw.warnings.join(" "), /raw preview/);
  }
});
