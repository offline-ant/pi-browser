import type { BrowserKind } from "./core/types.ts";

export interface BrowserDefaultState {
  configured: BrowserKind;
  override: BrowserKind | null;
  effective: BrowserKind;
  source: "override" | "host" | "environment" | "default";
}

export interface BrowserDefault {
  getState(): BrowserDefaultState;
  setOverride(value: BrowserKind | null): void;
}

export function isBrowserKind(value: unknown): value is BrowserKind {
  return value === "chromium" || value === "firefox";
}

/** Shared host policy, independent of Pi and of any browser process lifetime. */
export function createBrowserDefault(options: { browser?: BrowserKind } = {}, environment: NodeJS.ProcessEnv = process.env): BrowserDefault {
  const configured = options.browser ?? environment.PI_WEB_BROWSER ?? "chromium";
  if (!isBrowserKind(configured)) throw new Error("PI_WEB_BROWSER/browser must be chromium | firefox.");
  const source = options.browser !== undefined ? "host" : environment.PI_WEB_BROWSER !== undefined ? "environment" : "default";
  let override: BrowserKind | null = null;
  return {
    getState() { return { configured, override, effective: override ?? configured, source: override === null ? source : "override" }; },
    setOverride(value) {
      if (value !== null && !isBrowserKind(value)) throw new Error("Browser default override must be chromium | firefox | null.");
      override = value;
    },
  };
}
