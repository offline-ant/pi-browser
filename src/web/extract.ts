import type { PageCapture } from "../capture.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageInspection {
  url: string;
  title: string;
  ready: boolean;
  attention?: string;
  unsupported?: string;
  noResults: boolean;
  results: SearchResult[];
  markdown: string;
  limitations: string[];
}

/** One synchronous observation; polling omits artifact serialization. No page mutation. */
function observePage(kind: "search" | "fetch", engine: "duckduckgo" | "bing" | "brave", artifacts = false): PageInspection & { capture?: PageCapture } {
  const capturedAt = new Date().toISOString();
  const sourceUrl = location.href;
  const sourceTitle = document.title;
  const result: PageInspection & { capture?: PageCapture } = {
    url: sourceUrl.slice(0, 16_384), title: sourceTitle.slice(0, 6000), ready: document.readyState !== "loading", noResults: false,
    results: [], markdown: "", limitations: [],
  };
  // Snapshot once so code, tables, diagnostics and root selection all obey the
  // same bound, including inside shadow roots. Depth also bounds the JS stack.
  const maxNodes = 30_000;
  const maxText = 512 * 1024;
  const maxDepth = 128;
  const omitted = new Set<string>();
  const inert = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "AUDIO", "VIDEO"]);
  const ignored = new Set(["NAV", "FOOTER", "ASIDE", "FORM", "INPUT", "SELECT", "TEXTAREA", "DIALOG"]);
  interface Snapshot { element?: Element; text: string; children: Snapshot[]; readable: number; excluded?: boolean; shadow?: boolean; visible?: boolean }
  const links: { text: string; url: string }[] = [];
  const tables: Record<string, unknown>[] = [];
  const elements: Snapshot[] = [];
  let nodes = 0;
  let characters = 0;
  let limited = sourceUrl.length > 16_384 || sourceTitle.length > 6000;
  let metadataCharacters = 0;
  const metadataText = (text: string): string => {
    const value = text.slice(0, Math.max(0, maxText - metadataCharacters));
    if (value.length < text.length) limited = true;
    metadataCharacters += value.length;
    return value;
  };
  const plain = (root: Snapshot, limit = 6000, includeControls = false): string => {
    let text = "";
    const visit = (node: Snapshot) => {
      if (text.length >= limit) return;
      if (!includeControls && node.excluded) return;
      if (node.text) text += node.text.slice(0, limit - text.length);
      for (const child of node.children) { visit(child); if (text.length >= limit) break; }
      if (node.element && /^(P|DIV|MAIN|ARTICLE|SECTION|H[1-6]|LI|BR|TR|CAPTION|PRE)$/.test(node.element.tagName) && text.length < limit) text += "\n";
      if (node.element && /^(TD|TH)$/.test(node.element.tagName) && text.length < limit) text += "\t";
    };
    visit(root);
    return text;
  };
  const capture = (node: Node, depth: number): Snapshot | undefined => {
    if (++nodes > maxNodes || characters >= maxText || depth > maxDepth) { limited = true; return; }
    if (node.nodeType === Node.TEXT_NODE) {
      const source = node.textContent ?? "";
      const text = source.slice(0, maxText - characters).replace(/\u0000/g, "");
      if (source.length > text.length) limited = true;
      characters += text.length;
      return { text, children: [], readable: text.trim().length };
    }
    if (!(node instanceof Element)) return;
    if (inert.has(node.tagName) || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.contentVisibility === "hidden" || style.opacity === "0") return;
    // Unlike display:none, visibility can be overridden by a descendant.
    const visible = style.visibility !== "hidden" && style.visibility !== "collapse";
    const role = node.getAttribute("role");
    const excluded = ignored.has(node.tagName) || role === "navigation" || role === "toolbar";
    const snapshot: Snapshot = { element: node, text: "", children: [], readable: 0, excluded, shadow: !!node.shadowRoot, visible };
    elements.push(snapshot);
    const assigned = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : [];
    const children = assigned.length ? assigned : (node.shadowRoot ?? node).childNodes;
    for (const child of children) {
      if (nodes >= maxNodes || characters >= maxText) { limited = true; break; }
      if (!visible && child.nodeType === Node.TEXT_NODE) continue;
      if (node.tagName === "DETAILS" && !node.hasAttribute("open") && (!(child instanceof Element) || child.tagName !== "SUMMARY")) continue;
      const captured = capture(child, depth + 1);
      if (captured) {
        // Slots are insertion points, not semantic list/table containers.
        snapshot.children.push(...(captured.element instanceof HTMLSlotElement ? captured.children : [captured]));
        snapshot.readable += captured.readable;
      }
    }
    if (node.tagName === "BUTTON" || role === "button") {
      const controlLabel = (node.getAttribute("aria-label") || node.getAttribute("title") || plain(snapshot, 200, true)).slice(0, 201);
      if (/^(?:copy(?:\s+(?:code|link|text|url|permalink))?(?:\s+to clipboard)?|copied[!]?)$/i.test(controlLabel.trim())) snapshot.excluded = true;
    }
    if (visible && !snapshot.excluded && ["A", "BUTTON", "IMG"].includes(node.tagName) && (!snapshot.readable || !/[\p{L}\p{N}]/u.test(plain(snapshot, 200)))) {
      let label = node.getAttribute("alt") || node.getAttribute("aria-label") || "";
      if (!label) for (const id of (node.getAttribute("aria-labelledby") ?? "").slice(0, 1000).split(/\s+/)) {
        const scope = node.getRootNode();
        const target = scope instanceof Document || scope instanceof ShadowRoot ? scope.getElementById(id) : null;
        if (target) {
          const walker = document.createTreeWalker(target, NodeFilter.SHOW_ALL);
          let count = 0;
          let child: Node | null;
          while (label.length < 1000 && count++ < 128 && nodes < maxNodes && (child = walker.nextNode())) {
            nodes++;
            if (child.nodeType === Node.TEXT_NODE) label += (child.textContent ?? "").slice(0, 1000 - label.length);
          }
          if (count >= 128 || nodes >= maxNodes || label.length >= 1000) limited = true;
          label += " ";
        }
      }
      if (!label && node.tagName === "A") label = node.getAttribute("title") || "";
      if (label) {
        const text = label.slice(0, Math.min(6000, maxText - characters));
        if (text.length < label.length) limited = true;
        characters += text.length;
        snapshot.children = [{ text, children: [], readable: text.trim().length }];
        snapshot.readable = text.trim().length;
      }
    }
    if (snapshot.excluded) snapshot.readable = 0;
    return snapshot;
  };
  const body = document.body ? capture(document.body, 0) : undefined;
  const noteLimits = () => {
    if (limited) omitted.add("DOM extraction reached a node, text, depth, table, HTML or metadata limit (30,000 nodes, 524,288 text characters, 128 levels, 1,000 rows, 128 columns, 2 MiB HTML); content is incomplete.");
    result.limitations = [...omitted];
  };

  let selected = body;
  const finish = () => {
    noteLimits();
    if (artifacts) {
      const htmlEscape = (value: string) => value.replace(/[&<>\"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
      // Reconstruct inert HTML from the same bounded composed tree, never outerHTML.
      // Whitelisted attributes exclude scripts, handlers, resource loads and live form values.
      const prefix = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; form-action \'none\'; base-uri \'none\'"><title>' + htmlEscape(result.title.slice(0, 6000)) + "</title></head>";
      const suffix = "</html>";
      let htmlSize = prefix.length + suffix.length;
      const maxHtml = 2 * 1024 * 1024;
      const serialize = (node: Snapshot): string => {
        if (htmlSize >= maxHtml) { limited = true; return ""; }
        if (!node.element) {
          let escaped = htmlEscape(node.text);
          const remaining = maxHtml - htmlSize;
          if (escaped.length > remaining) { limited = true; escaped = htmlEscape(node.text.slice(0, Math.floor(remaining / 6))); }
          htmlSize += escaped.length;
          return escaped;
        }
        const element = node.element;
        const sourceTag = element.tagName.toLowerCase();
        const tag = /^(?:iframe|object|embed|form|input|select|textarea|plaintext|xmp)$/.test(sourceTag) || sourceTag.includes("-") ? "div" : sourceTag;
        let attributes = tag !== sourceTag ? ` data-pi-tag="${htmlEscape(sourceTag)}"` : "";
        if (node.shadow) attributes += ' data-pi-shadow-root="open"';
        if (node.excluded) attributes += ' data-pi-semantic="excluded"';
        for (const name of ["id", "class", "role", "aria-label", "aria-labelledby", "alt", "title", "colspan", "rowspan", "scope", "headers", "start", "lang", "data-language", "open"]) {
          const value = element.getAttribute(name);
          if (value !== null) {
            if (value.length > 1000) limited = true;
            attributes += ` ${name}="${htmlEscape(value.slice(0, 1000))}"`;
          }
        }
        if (sourceTag === "a") {
          const url = destination(node);
          if (url) attributes += ` href="${htmlEscape(url)}"`;
        }
        const opening = `<${tag}${attributes}>`;
        const closing = /^(?:br|hr|img|wbr)$/.test(tag) ? "" : `</${tag}>`;
        if (htmlSize + opening.length + closing.length > maxHtml) { limited = true; return ""; }
        htmlSize += opening.length + closing.length;
        return opening + node.children.map(serialize).join("") + closing;
      };
      const content = body ? serialize(body) : "<body></body>";
      noteLimits();
      const warnings = [...result.limitations,
        "Rendered composed-DOM snapshot; scripts/styles, hidden content, live form values, and resource loads omitted.",
        "Closed shadow roots, embedded documents, and canvas pixels are not captured."];
      const text = selected ? plain(selected, maxText, !!result.attention).trim() : "";
      result.capture = {
        capturedAt, html: prefix + content + suffix,
        md: result.markdown || text, text,
        json: {
          ...result, links, tables,
          capture: {
            capturedAt, source: "rendered-composed-dom", semanticScope: "selected-content", visibility: "computed",
            openShadowRoots: elements.filter(node => node.shadow).length,
            selectedTag: selected?.element?.tagName.toLowerCase(), nodes: Math.min(nodes, maxNodes), textCharacters: characters,
            limits: { nodes: maxNodes, textCharacters: maxText, depth: maxDepth, tableRows: 1000, tableColumns: 128, htmlCharacters: maxHtml },
            incomplete: limited,
          },
        },
        warnings,
      };
    }
    return result;
  };
  const destination = (node: Snapshot): string | undefined => {
    const href = node.element?.getAttribute("href");
    if (href && href.length > 16_384) { omitted.add("An oversized link destination was omitted."); return; }
    if (href == null) return;
    try {
      const url = new URL(href, document.baseURI || result.url);
      if (["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password) return url.href;
    } catch { /* Unsafe or malformed URLs stay text. */ }
  };
  if (!body) return finish();
  const bodyText = plain(body, 6001, true);
  const present = (node: Snapshot): boolean => node.visible !== false && (node.element?.getClientRects().length ?? 0) > 0;
  const matches = (node: Snapshot, selector: string): boolean => node.element?.matches(selector) ?? false;
  const dialogs = elements.filter(node => matches(node, 'dialog[open], [role="dialog"], [aria-modal="true"]') && present(node));
  const challenge = elements.some(node => matches(node, '#challenge-form, #challenge-running, #challenge-stage, form[action*="anomaly"], iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com/captcha"], iframe[src*="recaptcha/api2/bframe"]') && present(node));
  const challengeText = /please complete the following challenge|select all squares containing a duck|verifying you(?:'|’)re not a bot|verify (?:that )?you are (?:a )?human|checking your browser before|confirm (?:that )?you(?:'|’)re (?:a )?human/i;
  const challengeTitle = /^(?:captcha(?:\s*[-–|]\s*(?:brave search|duckduckgo))?|just a moment[.!…]*|access denied|security (?:check|verification)|privacy error|warning: potential security risk)(?:\s*[-–|].*)?$/i;
  const challengeMessage = bodyText.length < 2000 && /^(?:please |one more step[.!]?\s*)?(?:verify |confirm |verifying |checking your browser|select all squares|complete the following challenge)/i.test(bodyText.trim()) && challengeText.test(bodyText);
  if (challenge || challengeTitle.test(result.title.trim()) || dialogs.some(dialog => challengeText.test(plain(dialog, 3000, true))) || challengeMessage) {
    result.attention = "This page requires a human verification or access check. Complete it in the research browser, then Continue.";
  } else if (dialogs.some(dialog => /cookies|consent|privacy choices|sign in|log in/i.test(plain(dialog, 3000, true)))) {
    result.attention = "A consent or sign-in dialog is blocking the page. Review it in the research browser, then Continue.";
  } else if (elements.some(node => matches(node, 'input[type="password"]') && present(node)) && /sign in|log in|login/i.test(result.title + " " + bodyText.slice(0, 300)) && bodyText.length < 5000) {
    result.attention = "This page requires sign-in. Sign in manually in the research browser, then Continue.";
  }
  if (result.attention) return finish();
  if (document.contentType === "application/pdf" || elements.some(node => matches(node, 'embed[type="application/pdf"]'))) {
    result.unsupported = "PDF viewer content is not extracted as HTML. Inspect the document in the browser or use a dedicated PDF reader.";
    return finish();
  }
  if (kind === "search") {
    const selector = engine === "bing" ? 'li.b_algo' : engine === "brave" ? '.snippet[data-type="web"], #results .snippet' : '[data-testid="result"], .result';
    const seen = new Set<string>();
    const descendant = (node: Snapshot, selector: string): Snapshot | undefined => {
      for (const child of node.children) {
        if (matches(child, selector)) return child;
        const found = descendant(child, selector);
        if (found) return found;
      }
      return undefined;
    };
    for (const item of elements) {
      if (!matches(item, selector) || matches(item, '[data-testid*="ad"], .result--ad, .ad, [data-type="ad"]') || descendant(item, '[data-testid="ad-label"]')) continue;
      const anchor = descendant(item, engine === "bing" ? 'h2 a' : engine === "brave" ? 'a.heading-serpresult, a:has(.title), h2 a, h3 a' : 'a[data-testid="result-title-a"], a.result__a, h2 a');
      if (!anchor?.element) continue;
      let destination: URL;
      try {
        const href = anchor.element.getAttribute("href");
        if (!href || href.length > 16_384) continue;
        destination = new URL(href, location.href);
        if (/(^|\.)duckduckgo\.com$/.test(destination.hostname) && destination.searchParams.has("uddg")) destination = new URL(destination.searchParams.get("uddg")!);
        if (/(^|\.)bing\.com$/.test(destination.hostname) && destination.pathname === "/ck/a") {
          const encoded = destination.searchParams.get("u");
          if (encoded?.startsWith("a1")) {
            const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
            destination = new URL(new TextDecoder().decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0))));
          }
        }
      } catch { continue; }
      if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password) continue;
      const name = plain(anchor, 1000).replace(/\s+/g, " ").trim();
      if (!name) continue;
      const key = new URL(destination);
      key.hash = "";
      if (seen.has(key.href)) continue;
      seen.add(key.href);
      const snippet = descendant(item, engine === "bing" ? '.b_caption p' : engine === "brave" ? '.snippet-description, .content, .description' : '[data-result="snippet"], [data-testid="result-snippet"], .result__snippet');
      if (result.results.length === 100) {
        omitted.add("Search extraction is capped at 100 unique results; additional results were omitted.");
        limited = true;
        break;
      }
      result.results.push({ title: name, url: destination.href, snippet: snippet ? plain(snippet, 1800).replace(/\s+/g, " ").trim() : "" });
    }
    // A phrase in a query, help link or article is not an empty-result signal.
    // Require a short standalone message in a result/message container.
    result.noResults = !result.results.length && elements.some(node => {
      if (!matches(node, 'main, [role="main"], .b_no, .no-results, .no-results__message, [data-testid="no-results"]')) return false;
      const text = plain(node, 501).replace(/\s+/g, " ").trim();
      return text.length <= 500 && !descendant(node, "a") && /^(?:no (?:web |search )?results(?: found)?(?: for\b[^.!?]*)?|(?:your search\b.{0,250})?did not match any (?:documents|results)|we couldn't find any results)[.!]?$/i.test(text);
    });
    return finish();
  }

  // Match standalone loading labels with decorative punctuation/spinners, not
  // ordinary article prose such as "Loading files is useful".
  const loading = (node: Snapshot): boolean => matches(node, '[aria-busy="true"]') || /^(?:loading(?:\s+(?:content|page))?|please wait)[^\w]*$/i.test(plain(node, 200).trim());
  const mains = elements.filter(node => matches(node, 'main, [role="main"]'));
  const articles = elements.filter(node => matches(node, "article"));
  const usable = (node: Snapshot) => node.readable > 0 && !loading(node);
  const root = mains.find(usable) ?? articles.find(usable) ?? mains[0] ?? articles[0] ?? body;
  selected = root;
  if (loading(root) || !root.readable) { result.ready = false; return finish(); }
  const blocks: string[] = [];
  let rendered = 0;
  const emit = (text: string): string => {
    const remaining = Math.max(0, maxText - rendered);
    if (text.length > remaining) limited = true;
    const part = text.slice(0, remaining);
    rendered += part.length;
    return part;
  };
  const escape = (text: string): string => text.replace(/[\\`*_<>\[\]#|]/g, "\\$&");
  const longest = (text: string, character: string): number => {
    let maximum = 0;
    let run = 0;
    for (const value of text) { run = value === character ? run + 1 : 0; maximum = Math.max(maximum, run); }
    return maximum;
  };
  const codeText = (node: Snapshot): string => {
    if (node.excluded) return "";
    if (!node.element) return node.text;
    if (node.element.tagName === "BR") return "\n";
    const value = node.children.map(codeText).join("");
    return node.element.tagName === "DIV" && !value.endsWith("\n") ? value + "\n" : value;
  };
  const render = (node: Snapshot): string => {
    if (rendered >= maxText) { limited = true; return ""; }
    if (!node.element) return emit(escape(node.text.replace(/\s+/g, " ")));
    const element = node.element;
    const tag = element.tagName;
    if (node.excluded) return "";
    if (tag === "IFRAME") { omitted.add("Embedded frame contents are not included."); return ""; }
    if (tag === "PRE" || tag === "CODE") {
      const value = codeText(node).replace(/\r\n?/g, "\n");
      if (tag === "CODE") {
        const inline = value.replace(/\n/g, " ");
        const fence = "`".repeat(longest(inline, "`") + 1);
        const padding = inline.startsWith("`") || inline.endsWith("`") || (/^ .* $/.test(inline) && /[^ ]/.test(inline)) ? " " : "";
        const available = maxText - rendered - 2 * (fence.length + padding.length);
        if (available < 0) {
          limited = true;
          omitted.add("An oversized inline code delimiter could not be retained; code is rendered as escaped text.");
          return emit(escape(inline));
        }
        if (inline.length > available) limited = true;
        return emit(`${fence}${padding}${inline.slice(0, available)}${padding}${fence}`);
      }
      // Choose the shorter safe fence rather than allocating a huge delimiter
      // for a page containing an unusually long run of backticks.
      const ticks = Math.max(3, longest(value, "`") + 1);
      const tildes = Math.max(3, longest(value, "~") + 1);
      const fence = (ticks <= tildes ? "`" : "~").repeat(Math.min(ticks, tildes));
      const languageNode = node.children.find(child => child.element?.tagName === "CODE")?.element;
      let language = "";
      for (const candidate of [languageNode, element, element.parentElement]) {
        if (!candidate) continue;
        const explicit = candidate.getAttribute("data-language") || candidate.getAttribute("data-lang") || "";
        const hint = /^[\w+-]{1,40}$/.test(explicit) ? explicit : (candidate.getAttribute("class") ?? "").slice(0, 1000).match(/(?:^|\s)(?:language-|lang-|highlight-source-|brush:\s*)([\w+-]{1,40})(?:\s|$)/)?.[1];
        if (hint) { language = hint; break; }
      }
      const prefix = `${fence}${language}\n`;
      const suffix = `\n${fence}`;
      const available = maxText - rendered - prefix.length - suffix.length;
      if (available < 0) {
        limited = true;
        omitted.add("An oversized code delimiter could not be retained; remaining code is rendered as escaped text.");
        return emit(escape(value));
      }
      if (value.length > available) limited = true;
      const index = blocks.push(emit(prefix + value.slice(0, available) + suffix)) - 1;
      return `\n\n\u0000CODE${index}\u0000\n\n`;
    }
    if (tag === "TABLE") {
      const rows: Snapshot[] = [];
      const collect = (entry: Snapshot) => {
        if (rows.length >= 1000) { limited = true; return; }
        if (entry !== node && entry.element?.tagName === "TABLE") return;
        if (entry.element?.tagName === "TR") rows.push(entry);
        else for (const child of entry.children) collect(child);
      };
      collect(node);
      const cells = rows.map(row => row.children.filter(cell => /^(TD|TH)$/.test(cell.element?.tagName ?? "")));
      interface Cell { node: Snapshot; row: number; column: number; rowspan: number; colspan: number; header: boolean }
      const grid: (Cell | undefined)[][] = Array.from({ length: rows.length }, () => []);
      const originals: Cell[] = [];
      let width = 0;
      const hasBlockCell = (entry: Snapshot): boolean => entry.element?.tagName === "TABLE" || entry.element?.tagName === "PRE" || entry.children.some(hasBlockCell);
      let fallback = cells.some(row => row.some(cell => cell.children.some(hasBlockCell)));
      layout: for (let row = 0; row < cells.length; row++) {
        let column = 0;
        let groupEnd = row + 1;
        while (groupEnd < rows.length && rows[groupEnd].element?.parentElement === rows[row].element?.parentElement) groupEnd++;
        for (const cell of cells[row]) {
          while (column < 128 && grid[row][column]) column++;
          const colspan = Math.max(1, Number(cell.element?.getAttribute("colspan")) || 1);
          const sourceSpan = cell.element?.getAttribute("rowspan");
          const rowspan = Math.min(groupEnd - row, sourceSpan === "0" ? groupEnd - row : Math.max(1, Number(sourceSpan) || 1));
          if (!Number.isSafeInteger(colspan) || !Number.isSafeInteger(rowspan) || column + colspan > 128) { fallback = true; limited = true; break layout; }
          const entry: Cell = { node: cell, row, column, rowspan, colspan, header: cell.element?.tagName === "TH" };
          originals.push(entry);
          for (let y = row; y < row + rowspan; y++) for (let x = column; x < column + colspan; x++) {
            if (grid[y][x]) { fallback = true; break layout; }
            grid[y][x] = entry;
          }
          column += colspan;
          width = Math.max(width, column);
        }
      }
      let headerRows = 0;
      while (headerRows < cells.length && cells[headerRows].length && (rows[headerRows].element?.parentElement?.tagName === "THEAD" || cells[headerRows].every(cell => cell.element?.tagName === "TH"))) headerRows++;
      // An all-TH body is a data table with row headers, not an empty header-only table.
      if (headerRows === cells.length && headerRows > 1 && rows[0].element?.parentElement?.tagName !== "THEAD") headerRows = 1;
      const caption = node.children.find(child => child.element?.tagName === "CAPTION");
      const captionText = caption ? plain(caption, 6000).trim() : "";
      if (artifacts) tables.push({
        caption: metadataText(captionText), rows: rows.length, columns: width, headerRows,
        representation: fallback ? "source-rows" : "span-grid",
        ...(fallback ? {
          sourceRows: cells.map(row => row.slice(0, 128).map(cell => metadataText(plain(cell, maxText).trim()))),
        } : {
          cells: originals.map(cell => ({
            row: cell.row, column: cell.column, rowspan: cell.rowspan, colspan: cell.colspan,
            header: cell.header, text: metadataText(plain(cell.node, maxText).trim()),
          })),
        }),
      });
      let output = emit("\n\n" + (captionText ? escape(captionText) + "\n\n" : ""));
      if (fallback) {
        omitted.add("A table has overlapping or oversized spans/columns, or nested block content; source rows are shown in order instead of an ambiguous Markdown grid.");
        output += emit("[Table: source rows; column alignment unavailable]\n");
        for (let row = 0; row < cells.length && rendered < maxText; row++) {
          output += emit(`\nRow ${row + 1}:\n`);
          for (const cell of cells[row].slice(0, 128)) output += emit("- ") + emit(escape(plain(cell, maxText).trim()).replace(/\n/g, " ")) + emit("\n");
        }
        return output + emit("\n");
      }
      if (!width) return output;
      const cache = new Map<Cell, string>();
      const renderCell = (cell: Cell | undefined): string => {
        if (!cell) return "";
        const previous = cache.get(cell);
        if (previous !== undefined) return emit(previous);
        const value = cell.node.children.map(render).join("").trim().replace(/\n+/g, "<br>")
          .replace(/\\*\|/g, pipe => pipe.length % 2 === 1 ? `\\${pipe}` : pipe);
        cache.set(cell, value);
        return value;
      };
      output += emit("| ");
      for (let column = 0; column < width && rendered < maxText; column++) {
        const headers = new Set<Cell>();
        for (let row = 0; row < headerRows; row++) { const cell = grid[row][column]; if (cell && plain(cell.node, maxText).trim()) headers.add(cell); }
        if (!headers.size) output += emit(`Column ${column + 1}`);
        let first = true;
        for (const header of headers) {
          if (!first) output += emit(" / ");
          output += renderCell(header);
          first = false;
        }
        output += emit(column === width - 1 ? " |\n" : " | ");
      }
      output += emit(`| ${Array.from({ length: width }, () => "---").join(" | ")} |\n`);
      for (let row = headerRows; row < grid.length && rendered < maxText; row++) {
        output += emit("| ");
        for (let column = 0; column < width && rendered < maxText; column++) output += renderCell(grid[row][column]) + emit(column === width - 1 ? " |\n" : " | ");
      }
      return output + emit("\n\n");
    }
    if (tag === "UL" || tag === "OL") {
      let count = Number(element.getAttribute("start") ?? 1);
      if (!Number.isSafeInteger(count)) count = 1;
      return emit("\n") + node.children.filter(child => child.element?.tagName === "LI").map(child => {
        const prefix = emit(tag === "OL" ? `${count++}. ` : "- ");
        return prefix + child.children.map(render).join("").trim().replace(/\n+/g, "\n  ");
      }).join("\n") + emit("\n");
    }
    if (tag === "A") {
      const label = node.children.map(render).join("").trim();
      const url = destination(node);
      if (url && label) {
        if (artifacts) links.push({ text: metadataText(plain(node, 6000).replace(/\s+/g, " ").trim()), url });
        return emit("[") + label + emit(`](<${url.replace(/[<>\\]/g, character => encodeURIComponent(character))}>)`);
      }
      return label;
    }
    if (tag === "IMG") {
      const alt = plain(node, maxText);
      return alt ? emit(`[Image: ${escape(alt)}]`) : "";
    }
    const content = node.children.map(render).join("");
    if (/^H[1-6]$/.test(tag)) return emit(`\n\n${"#".repeat(Number(tag[1]))} `) + content.trim() + emit("\n\n");
    if (tag === "BR") return emit("\n");
    if (tag === "HR") return emit("\n\n---\n\n");
    if (tag === "STRONG" || tag === "B") return emit("**") + content.trim() + emit("**");
    if (tag === "EM" || tag === "I") return emit("*") + content.trim() + emit("*");
    if (tag === "BLOCKQUOTE") return emit("\n\n") + content.trim().split("\n").map(line => emit("> ") + line).join("\n") + emit("\n\n");
    if (["P", "DIV", "SECTION", "ARTICLE", "MAIN", "DL", "DT", "DD", "FIGURE", "FIGCAPTION"].includes(tag)) return emit("\n\n") + content.trim() + emit("\n\n");
    return content;
  };
  const markdown = render(root).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? "");
  if (markdown.length > maxText) limited = true;
  result.markdown = markdown.slice(0, maxText);
  return finish();
}

export function inspectPage(kind: "search" | "fetch", engine: "duckduckgo" | "bing" | "brave"): PageInspection {
  return observePage(kind, engine);
}

export function inspectionExpression(kind: "search" | "fetch", engine: "duckduckgo" | "bing" | "brave"): string {
  return `(${observePage.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(engine)})`;
}

export function captureExpression(kind: "search" | "fetch" = "fetch", engine: "duckduckgo" | "bing" | "brave" = "duckduckgo"): string {
  return `(${observePage.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(engine)}, true).capture`;
}
