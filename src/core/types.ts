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
  /** Chromium: evaluate only in this document from `document()`; fails if it is gone. */
  document?: string;
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
  /** A launched browser's sole startup tab, as an owned tab; the window then has no anchor. Closing it may stop the browser. */
  startupTab(): Promise<BrowserTab>;
  /** Chromium: calls `listener` for every new top-level page, including ones this session opens. */
  onPage(listener: (page: { id: string; url: string }) => void): () => void;
  /** Close owned tabs; stop the browser only when this session launched it. */
  close(): Promise<void>;
  /**
   * Immediately ends a launched browser's process tree (SIGKILL to its own process group), without
   * closing the connection or releasing the profile; close() afterwards. For a host being terminated, or one
   * discarding the profile: a graceful close() alone can leave helper processes running for seconds.
   */
  kill(): void;
}

export interface BrowserTab {
  readonly id: string;
  /** True after manual/explicit closure, destructive interruption, or session loss. */
  readonly closed: boolean;
  /** Resolves once the tab closes: manual or explicit closure, destructive interruption, or session closure. */
  readonly whenClosed: Promise<void>;
  navigate(url: string, options?: OperationOptions): Promise<void>;
  /** Evaluate one expression; returned Promises are awaited in both engines. Page exceptions reject with `ScriptError`. */
  evaluate(expression: string, options?: OperationOptions): Promise<unknown>;
  /** Chromium: the current document's identity and URL, read from the browser protocol rather than page JavaScript. */
  document(): Promise<{ id: string; url: string }>;
  /** Chromium: reloads the page and resolves the new document once its DOM is loaded. */
  reload(options?: OperationOptions): Promise<{ id: string; url: string }>;
  info(): Promise<{ url: string; title: string }>;
  /** Base64-encoded PNG. */
  screenshot(): Promise<string>;
  /** Light-DOM HTML. Web extraction explicitly traverses open shadow roots. */
  html(): Promise<string>;
  focus(): Promise<void>;
  close(): Promise<void>;
}
