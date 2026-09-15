import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

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
  browser: "chromium" | "firefox";
  searchEngine: "duckduckgo" | "bing" | "brave";
  headless: boolean;
  profileDir: string;
  executable?: string;
}

export interface WebAttention {
  id: string;
  reason: string;
  url: string;
  tabId: string;
}

export type AttentionHandler = (request: WebAttention, signal?: AbortSignal) => Promise<boolean>;

function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${name} must be ${choices.join(" | ")}.`);
  return value as T;
}

function boolean(value: unknown): boolean {
  if (value === undefined || value === "0" || value === "false" || value === false) return false;
  if (value === "1" || value === "true" || value === true) return true;
  throw new Error("PI_BROWSER_HEADLESS/headless must be true, false, 1, or 0.");
}

/** Host configuration only: page content and model tool arguments cannot select a backend. */
export function resolveWebSettings(
  overrides: Partial<WebSettings> = {},
  environment: NodeJS.ProcessEnv = process.env,
  profileDir?: string,
): WebSettings {
  // Hosts should supply a stable, session-scoped path for cross-launch cookies.
  // Anonymous SDK clients must not contend for one global browser profile.
  const directory = overrides.profileDir ?? environment.PI_WEB_PROFILE_DIR ?? profileDir ?? path.join(homedir(), ".pi-browser", "web", `${process.pid}-${randomUUID()}`);
  const executable = overrides.executable ?? environment.PI_BROWSER_EXECUTABLE;
  if (typeof directory !== "string" || !directory.trim()) throw new Error("Web profileDir/PI_WEB_PROFILE_DIR must not be empty.");
  if (executable !== undefined && (typeof executable !== "string" || !executable.trim())) throw new Error("PI_BROWSER_EXECUTABLE/executable must not be empty.");
  return {
    backend: choice(overrides.backend ?? environment.PI_WEB_BACKEND ?? "auto", ["auto", "codex", "browser"], "PI_WEB_BACKEND/backend"),
    browser: choice(overrides.browser ?? environment.PI_WEB_BROWSER ?? "chromium", ["chromium", "firefox"], "PI_WEB_BROWSER/browser"),
    searchEngine: choice(overrides.searchEngine ?? environment.PI_WEB_SEARCH_ENGINE ?? "duckduckgo", ["duckduckgo", "bing", "brave"], "PI_WEB_SEARCH_ENGINE/searchEngine"),
    headless: boolean(overrides.headless ?? environment.PI_BROWSER_HEADLESS),
    profileDir: path.resolve(directory),
    ...(executable === undefined ? {} : { executable }),
  };
}
