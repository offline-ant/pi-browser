export type WebBackend = "auto" | "codex" | "browser";

export interface WebBackendState {
  configured: WebBackend;
  override: WebBackend | null;
  effective: WebBackend;
  source: "override" | "host" | "environment" | "default";
}

export function isWebBackend(value: unknown): value is WebBackend {
  return value === "auto" || value === "codex" || value === "browser";
}

export interface WebSettings {
  backend: WebBackend;
  searchEngine: "duckduckgo" | "bing" | "brave";
}

export interface WebAttention {
  id: string;
  reason: string;
  url: string;
  /** Research tab name in the shared browser. */
  tab: string;
}

export type AttentionHandler = (request: WebAttention, signal?: AbortSignal) => Promise<boolean>;

function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${name} must be ${choices.join(" | ")}.`);
  return value as T;
}

/** Host configuration only: page content and model tool arguments cannot select a backend. */
export function resolveWebSettings(overrides: Partial<WebSettings> = {}, environment: NodeJS.ProcessEnv = process.env): WebSettings {
  return {
    backend: choice(overrides.backend ?? environment.PI_WEB_BACKEND ?? "browser", ["auto", "codex", "browser"], "PI_WEB_BACKEND/backend"),
    searchEngine: choice(overrides.searchEngine ?? environment.PI_WEB_SEARCH_ENGINE ?? "duckduckgo", ["duckduckgo", "bing", "brave"], "PI_WEB_SEARCH_ENGINE/searchEngine"),
  };
}
