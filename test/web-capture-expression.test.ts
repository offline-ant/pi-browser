import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { PageCapture } from "../src/capture.ts";
import { captureExpression, inspectionExpression, type PageInspection } from "../src/web/extract.ts";

// Minimal rendered-DOM fixture for the Bing selector path; no browser process.
class TextNode {
  readonly nodeType = 3;
  readonly textContent: string;
  constructor(text: string) { this.textContent = text; }
}
class ElementNode {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: (ElementNode | TextNode)[];
  readonly attributes: Record<string, string>;
  parentElement?: ElementNode;
  constructor(tag: string, children: (ElementNode | TextNode)[] = [], attributes: Record<string, string> = {}) {
    this.tagName = tag;
    this.childNodes = children;
    this.attributes = attributes;
    for (const child of children) if (child instanceof ElementNode) child.parentElement = this;
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  getClientRects() { return [{}]; }
  matches(selector: string): boolean {
    return selector.split(/,\s*/).some(part => {
      if (part === "li.b_algo") return this.tagName === "LI" && this.attributes.class === "b_algo";
      if (part === "h2 a") return this.tagName === "A" && this.parentElement?.tagName === "H2";
      if (part === ".b_caption p") return this.tagName === "P" && this.parentElement?.attributes.class === "b_caption";
      return part.toUpperCase() === this.tagName;
    });
  }
}
class SlotNode extends ElementNode {}

function observe(count: number, artifacts: boolean): PageCapture | PageInspection {
  const body = new ElementNode("BODY", Array.from({ length: count }, (_, index) => new ElementNode("LI", [
    new ElementNode("H2", [new ElementNode("A", [new TextNode(`Source ${index}`)], { href: `https://source.test/${index}` })]),
    new ElementNode("DIV", [new ElementNode("P", [new TextNode(`Snippet ${index}`)])], { class: "b_caption" }),
  ], { class: "b_algo" })));
  return runInNewContext(artifacts ? captureExpression("search", "bing") : inspectionExpression("search", "bing"), {
    document: { body, title: "Final search", readyState: "complete", contentType: "text/html", baseURI: "https://www.bing.com/search?q=fixture" },
    location: { href: "https://www.bing.com/search?q=fixture" },
    Node: { TEXT_NODE: 3 }, Element: ElementNode, HTMLSlotElement: SlotNode, URL,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible" }),
  }) as PageCapture | PageInspection;
}

test("search capture retains more than twenty results from the same inspection and marks the hundred-result cap", () => {
  for (const count of [35, 100, 101]) {
    const capture = observe(count, true) as PageCapture;
    const poll = observe(count, false) as PageInspection;
    const inspection = capture.json as unknown as PageInspection;
    assert.equal(inspection.url, "https://www.bing.com/search?q=fixture");
    assert.equal(inspection.title, "Final search");
    assert.equal(inspection.ready, true);
    assert.equal(inspection.noResults, false);
    assert.equal(inspection.results.length, Math.min(count, 100));
    assert.equal(JSON.stringify(inspection.results), JSON.stringify(poll.results));
    assert.equal(capture.warnings.some(warning => /capped at 100/.test(warning)), count > 100);
    assert.equal((capture.json.capture as { incomplete: boolean }).incomplete, count > 100);
    assert.equal(inspection.results.at(-1)?.title, `Source ${Math.min(count, 100) - 1}`);
    assert.match(capture.html, /Source 34/);
    assert.equal("capture" in poll, false, "polling remains artifact-free");
  }
});
