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

/** Connect to an external browser without owning its process or profile. */
export interface BrowserConnectOptions {
  /** Unix socket forwarding to the publisher's 127.0.0.1:9222 debugging port. */
  socketPath: string;
  signal?: AbortSignal;
}

export interface OperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BrowserSession {
  /** True once cleanup starts or the connection/owned process is lost. */
  readonly closed: boolean;
  readonly browser: BrowserKind;
  openTab(url?: string): Promise<BrowserTab>;
  /** Top-level pages, including ones opened by people or pages. */
  pages(): Promise<{ id: string; url: string; title?: string }[]>;
  /** Use an existing page; attached pages are not closed by close(). */
  tab(id: string): Promise<BrowserTab>;
  /** Close owned tabs; stop the browser only when this session launched it. */
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
