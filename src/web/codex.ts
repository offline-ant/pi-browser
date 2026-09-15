import { randomUUID } from "node:crypto";
import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable, validateWebUrl } from "./async.ts";
import { formatSearchResults } from "./browser.ts";
import type { SearchResult } from "./extract.ts";

export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const AUTH_PROVIDER = "openai-codex";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Only availability failures opt in to auto fallback; malformed responses remain errors. */
export class CodexUnavailable extends Error {}

export interface CodexResponse extends Record<string, unknown> {
  output: string;
}

export interface CodexResult {
  model: string;
  endpoint: string;
  response: CodexResponse;
}

export interface CodexContent {
  md: string;
  text?: string;
  preview: string;
  warnings: string[];
  results?: SearchResult[];
  sourceCount?: number;
  returnedCount?: number;
}

/** Reject partial interpretations: structured results, not prose headers, define search sources. */
function searchResults(value: unknown): SearchResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const results: SearchResult[] = [];
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object") return undefined;
    const item = entry as Record<string, unknown>;
    if (item.type !== "text_result" ||
        typeof item.domain !== "string" || typeof item.ref_id !== "string" || !item.ref_id.trim() ||
        typeof item.title !== "string" || !item.title.trim() || typeof item.snippet !== "string" || typeof item.url !== "string") return undefined;
    try { results.push({ title: item.title, snippet: item.snippet, url: validateWebUrl(item.url) }); }
    catch { return undefined; }
  }
  return results;
}

type Fence = { character: string; length: number };
function nextFence(line: string, fence: Fence | undefined): Fence | undefined {
  const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!marker) return fence;
  if (!fence) return { character: marker[1]![0]!, length: marker[1]!.length };
  return marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim() ? undefined : fence;
}

// Match whole inline code spans before interpreting provider citations. Labels may themselves contain code.
const PROSE_TOKEN = /(`+)(?!`)[^\r\n]*?\1(?!`)|cite[^\r\n]+|【[^】\r\n]+】/g;
function citationLabel(token: string): string {
  const match = token.match(/^(?:cite|【)\d+†([^†】]+)(?:†[^】]+)?(?:|】)$/);
  return match?.[1] ?? token;
}

/** Physical lines can contain several numbered lines, joined immediately after a citation. */
function unwrapLines(body: string[]): string[] | undefined {
  const lines: string[] = [];
  let expected: number | undefined;
  let fence: Fence | undefined;
  for (const physical of body) {
    if (!physical) { lines.push(""); continue; }
    const wrapper = physical.match(/^L(\d+): ?(.*)$/);
    if (!wrapper || (expected !== undefined && Number(wrapper[1]) !== expected)) return undefined;
    expected = Number(wrapper[1]) + 1;
    const content = wrapper[2]!;
    let start = 0;
    if (!fence && (!/^(?: {4}|\t)/.test(content) || /^\s+(?:[*+-]|\d+\.) +/.test(content))) {
      for (const token of content.matchAll(PROSE_TOKEN)) {
        if (token[0].startsWith("`")) continue;
        const end = token.index + token[0].length;
        const joined = content.slice(end).match(/^ L(\d+): ?/);
        if (!joined || Number(joined[1]) !== expected) continue;
        lines.push(content.slice(start, end));
        start = end + joined[0].length;
        expected++;
      }
    }
    lines.push(content.slice(start));
    fence = nextFence(content.slice(start), fence);
  }
  return expected === undefined ? undefined : lines;
}

function normalizeArticle(lines: string[]): { md: string; text: string } {
  const markdown: string[] = [];
  const text: string[] = [];
  let fence: Fence | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const after = nextFence(line, fence);
    if (fence || after) {
      markdown.push(line);
      if (fence === after) text.push(line);
      fence = after;
      continue;
    }
    // Only the provider's complete, indented, single-backtick wrapper is removable.
    if (/^ {4}`[^`]/.test(line) && !line.endsWith("`")) {
      let end = index + 1;
      while (end < lines.length && (lines[end] === "" || /^ {4}/.test(lines[end]!)) && lines[end] !== "    `") end++;
      if (lines[end] === "    `") {
        const code = lines.slice(index, end).map(value => value.startsWith("    ") ? value.slice(4) : value);
        code[0] = code[0]!.slice(1);
        const longest = Math.max(2, ...Array.from(code.join("\n").matchAll(/`+/g), match => match[0].length));
        const marker = "`".repeat(longest + 1);
        markdown.push(marker, ...code, marker);
        text.push(...code);
        index = end;
        continue;
      }
    }
    if (/^(?: {4}|\t)/.test(line)) { markdown.push(line); text.push(line); continue; }
    const labeled = line.replace(PROSE_TOKEN, citationLabel);
    markdown.push(labeled);
    text.push(labeled.replace(/^ {0,3}#{1,6} +/, "")
      .replace(/cite[^\r\n]+|【[^】\r\n]+】|(`+)(?!`)(.*?)\1(?!`)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|<https?:\/\/[^>\n]+>)\)/g,
        (match, ticks: string | undefined, code: string, label: string | undefined, url: string) => ticks ? code : label === undefined ? match : `${label} (${url.replace(/^<|>$/g, "")})`));
  }
  return { md: markdown.join("\n"), text: text.join("\n") };
}

export function formatCodex(kind: "search" | "fetch", response: CodexResponse, maxResults: number): CodexContent {
  const { output } = response;
  if (kind === "search") {
    const sources = searchResults(response.results);
    if (sources) {
      const seen = new Set<string>();
      const results = sources.filter(source => {
        const canonical = new URL(source.url);
        canonical.hash = "";
        if (seen.has(canonical.href)) return false;
        seen.add(canonical.href);
        return true;
      });
      const duplicates = sources.length - results.length;
      return {
        md: formatSearchResults(results), preview: formatSearchResults(results.slice(0, maxResults), true),
        text: results.length ? results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ""}`).join("\n\n") : "The search engine reported no results.",
        results, sourceCount: sources.length, returnedCount: Math.min(results.length, maxResults),
        warnings: duplicates ? [`Omitted ${duplicates} duplicate source URLs (ignoring fragments only); all source references remain in snapshot JSON.`] : [],
      };
    }
  } else {
    const lines = output.split(/\r?\n/);
    const header = lines[0]?.match(/^(.+) \((https?:\/\/\S+)\)$/);
    const reference = /^(?:cite[^\r\n]+|【[^】\r\n]+】)\s*\[wordlim:\s*\d+\]/.test(lines[1] ?? "");
    if (header && reference && /\bContent type: [^;]+; Source: open\(/.test(lines[1]!)) {
      let safeUrl = false;
      try { validateWebUrl(header[2]!); safeUrl = true; } catch { /* Keep unsafe/unknown wrappers raw. */ }
      const body = safeUrl ? unwrapLines(lines.slice(2)) : undefined;
      if (body) {
        const warnings: string[] = [];
        const firstHeading = body.findIndex(line => /^# +\S/.test(line));
        const title = header[1]!;
        const heading = firstHeading < 0 ? "" : body[firstHeading]!.slice(2).replace(PROSE_TOKEN, citationLabel).trim();
        const matchingTitle = heading && (title === heading || title.startsWith(`${heading} - `) || title.startsWith(`${heading} | `));
        const preamble = body.slice(0, Math.max(0, firstHeading));
        const skipLink = preamble.some(line => [...line.matchAll(PROSE_TOKEN)].some(token => /^Skip to (?:main )?content$/i.test(citationLabel(token[0]))));
        if (firstHeading > 0 && matchingTitle && skipLink && !preamble.some(line => /^ {0,3}(`{3,}|~{3,})/.test(line))) {
          body.splice(0, firstHeading);
          warnings.push(`Omitted ${firstHeading} preamble lines before the title-matching article H1 and after a skip-content link; raw output retained.`);
        }
        warnings.push("Provider citation labels are retained without invented URLs; unknown references and unconfirmed navigation remain verbatim.");
        const content = normalizeArticle(body);
        return { ...content, preview: content.md, warnings };
      }
    }
  }
  return { md: output, preview: output, warnings: [
    kind === "search" ? "Missing or malformed Codex structured results; showing a raw preview. Original response remains in snapshot JSON."
      : "Unrecognized Codex fetch format; showing a raw preview. Original response and provenance remain in snapshot JSON.",
    ...(kind === "search" ? ["Source count is unknown; max_results could not be reliably enforced."] : []),
  ] };
}

function accountId(token: string): string | undefined {
  const credential = readStoredCredential(AUTH_PROVIDER);
  if (credential?.type === "oauth" && typeof credential.accountId === "string" && credential.accountId) return credential.accountId;
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return undefined;
    const auth = (payload as Record<string, unknown>)["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return undefined;
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch { return undefined; }
}

async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Codex web response exceeded the 2 MiB transport limit.");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(error instanceof TypeError ? new TypeError(message) : new Error(message), { response: Buffer.concat(chunks).toString("utf8"), responsePartial: true });
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function runCodex(
  kind: "search" | "fetch",
  value: string,
  maxResults: number,
  context: Pick<ExtensionContext, "modelRegistry" | "model">,
  signal?: AbortSignal,
): Promise<CodexResult> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let token: string | undefined;
  try { token = await abortable(context.modelRegistry.getApiKeyForProvider(AUTH_PROVIDER), requestSignal); }
  catch (error) {
    signal?.throwIfAborted();
    throw new CodexUnavailable(`Codex credentials unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  signal?.throwIfAborted();
  if (!token) throw new CodexUnavailable("No OpenAI Codex OAuth token found. Run Pi /login for ChatGPT Plus/Pro (Codex Subscription), or use the browser backend.");
  const account = accountId(token);
  if (!account) throw new CodexUnavailable("Codex credentials contain no ChatGPT account ID. Run Pi /login for openai-codex again.");
  const model = context.model?.provider === AUTH_PROVIDER ? context.model.id : "gpt-5.6-sol";
  const commands = kind === "search"
    ? { search_query: [{ q: value }], response_length: maxResults <= 3 ? "short" : maxResults <= 6 ? "medium" : "long" }
    : { open: [{ ref_id: value }], response_length: "long" };
  let response: Response;
  let body: string;
  try {
    response = await abortable(fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, "ChatGPT-Account-ID": account,
        "Content-Type": "application/json", "User-Agent": "pi-browser/codex-web", originator: "pi-browser",
      },
      body: JSON.stringify({ id: randomUUID(), model, commands, settings: { allowed_callers: ["direct"], external_web_access: true }, max_output_tokens: 8000 }),
      signal: requestSignal,
    }), requestSignal);
    body = await responseText(response, requestSignal);
  } catch (error) {
    const reason = signal?.aborted ? signal.reason : error;
    const message = reason instanceof Error ? reason.message : String(reason);
    const failure = !signal?.aborted && (requestSignal.aborted || error instanceof TypeError) ? new CodexUnavailable(`Codex web transport unavailable: ${message}`) : new Error(message);
    if (error && typeof error === "object" && "response" in error) Object.assign(failure, { response: error.response, responsePartial: true });
    throw failure;
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    const message = body.trim().slice(0, 1000) || response.statusText;
    const reason = `Codex web API request failed (${response.status}): ${message}`;
    const unavailable = [401, 403, 404, 405, 408, 429].includes(response.status) || response.status >= 500 ||
      (response.status === 400 && /unsupported|not supported|unknown model|model.{0,50}not found/i.test(message));
    throw Object.assign(unavailable ? new CodexUnavailable(reason) : new Error(reason), { response: body });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { throw Object.assign(new Error("Codex web API returned invalid JSON; browser fallback was not attempted for a malformed response."), { response: body }); }
  if (typeof parsed !== "object" || parsed === null || !("output" in parsed) || typeof parsed.output !== "string") {
    throw Object.assign(new Error("Codex web API response missing output; browser fallback was not attempted for a malformed response."), { response: parsed });
  }
  return { model, endpoint: CODEX_ENDPOINT, response: parsed as CodexResponse };
}
