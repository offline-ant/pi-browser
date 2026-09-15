export type BrowserKind = "chromium" | "firefox";

/** A dedicated profile is owned exclusively until the session closes. */
export interface BrowserOptions {
  browser?: BrowserKind;
  profileDir: string;
  /** Defaults to false. A missing graphical display is an error, not a headless fallback. */
  headless?: boolean;
  executable?: string;
  /** Explicit Chromium-only sandbox opt-out. */
  noSandbox?: boolean;
}

export interface OperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BrowserSession {
  /** True once shutdown starts or the owned process/transport is lost. */
  readonly closed: boolean;
  openTab(url?: string): Promise<BrowserTab>;
  close(): Promise<void>;
}

export interface BrowserTab {
  readonly id: string;
  /** True after manual/explicit closure, destructive interruption, or session loss. */
  readonly closed: boolean;
  navigate(url: string, options?: OperationOptions): Promise<void>;
  /** Evaluate one expression; returned Promises are awaited in both engines. */
  evaluate(expression: string, options?: OperationOptions): Promise<unknown>;
  info(): Promise<{ url: string; title: string }>;
  /** Base64-encoded PNG. */
  screenshot(): Promise<string>;
  /** Light-DOM HTML. Web extraction explicitly traverses open shadow roots. */
  html(): Promise<string>;
  focus(): Promise<void>;
  close(): Promise<void>;
}
