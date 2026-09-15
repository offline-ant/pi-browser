import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserKind, BrowserOptions } from "./types.ts";

export class BrowserLaunchError extends Error {
  readonly diagnostics: string;
  constructor(message: string, diagnostics: string) {
    super(message);
    this.name = "BrowserLaunchError";
    this.diagnostics = diagnostics;
  }
}

/** Public tool errors must not expose host paths, environment, or profile-owner files. */
export function publicBrowserError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && ("path" in error || "syscall" in error)) {
    const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "unavailable";
    return `Browser host operation failed (${code}); ask the host operator to inspect its configuration.`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface NativeBrowserProcess {
  kind: BrowserKind;
  child: ChildProcess;
  /** Browser-level CDP endpoint or Firefox's /session BiDi endpoint. */
  endpoint: string;
}

interface LaunchOptions extends BrowserOptions {
  /** Application-owned flags, for example a local workspace hostname mapping. */
  chromiumArgs?: string[];
}

async function socketAvailable(address: string | { host: string; port: number }): Promise<boolean> {
  return new Promise(resolve => {
    const socket = typeof address === "string" ? createConnection(address) : createConnection(address);
    const finish = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

type DisplayBackend = "wayland" | "x11" | "native";

async function availableDisplay(): Promise<DisplayBackend | undefined> {
  // Linux can have inherited, stale DISPLAY values (SSH/tmux/containers). Probe
  // the actual display socket instead of silently starting an invisible browser.
  if (process.platform !== "linux") return "native";
  const wayland = process.env.WAYLAND_DISPLAY;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (wayland && (path.isAbsolute(wayland) || runtime)) {
    if (await socketAvailable(path.isAbsolute(wayland) ? wayland : path.join(runtime!, wayland))) return "wayland";
  }
  const display = process.env.DISPLAY?.match(/^(?:([^:]+))?:(\d+)(?:\.\d+)?$/);
  if (!display) return undefined;
  const host = display[1];
  const number = Number(display[2]);
  // Linux X11 clients try the abstract socket as well as the filesystem socket.
  // The latter can deny access even while the abstract transport works normally.
  const reachable = !host || host === "unix"
    ? await socketAvailable(`\0/tmp/.X11-unix/X${number}`) || await socketAvailable(`/tmp/.X11-unix/X${number}`)
    : await socketAvailable({ host, port: 6000 + number });
  return reachable ? "x11" : undefined;
}

export async function findBrowserExecutable(kind: BrowserKind, requested = process.env[kind === "chromium" ? "CHROMIUM_BINARY" : "FIREFOX_BINARY"]): Promise<string | undefined> {
  const candidates = requested ? [requested] : kind === "firefox" ? ["firefox"] : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  for (const candidate of candidates) {
    const locations = candidate.includes(path.sep) ? [candidate] : (process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, candidate));
    for (const location of locations) {
      try { await access(location, constants.X_OK); return location; }
      catch { /* Try the next executable. */ }
    }
  }
  return undefined;
}

/** A single profile lease survives controlled process restarts, but not close(). */
export class BrowserProcessLauncher {
  private options: LaunchOptions;
  private kind: BrowserKind;
  private command: string;
  private lock: string;
  private display?: DisplayBackend;
  private current?: NativeBrowserProcess;
  private starting?: Promise<NativeBrowserProcess>;
  private startingChild?: ChildProcess;
  private stopped = new WeakMap<ChildProcess, Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;

  private constructor(options: LaunchOptions, kind: BrowserKind, command: string, lock: string, display?: DisplayBackend) {
    this.options = options;
    this.kind = kind;
    this.command = command;
    this.lock = lock;
    this.display = display;
  }

  static async create(options: LaunchOptions): Promise<BrowserProcessLauncher> {
    const kind = options.browser ?? "chromium";
    if (kind !== "chromium" && kind !== "firefox") throw new Error("Unsupported browser. Use chromium or firefox.");
    if (kind === "firefox" && options.noSandbox) throw new Error("Firefox does not support noSandbox; keep its sandbox enabled");
    const display = options.headless ? undefined : await availableDisplay();
    if (!options.headless && !display) {
      throw new Error("No graphical display is reachable. Browser tools require a visible display; set headless explicitly only for unattended use or tests.");
    }
    const command = await findBrowserExecutable(kind, options.executable);
    if (!command) throw new BrowserLaunchError(`${kind === "firefox" ? "Firefox" : "Chromium"} executable not found; ask the host operator to check its configuration.`, `Requested executable: ${options.executable ?? process.env[kind === "chromium" ? "CHROMIUM_BINARY" : "FIREFOX_BINARY"] ?? kind}`);
    await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
    const profileDir = await realpath(options.profileDir);
    const lock = path.join(profileDir, ".pi-browser-owner");
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = "";
      try { owner = (await readFile(path.join(lock, "owner.json"), "utf8")).trim(); } catch { /* A competing launcher may still be writing it. */ }
      throw new BrowserLaunchError("Browser profile is already owned. Close its owner before reuse; ask the host operator for recovery if it has stopped.", `Profile: ${profileDir}. ${owner} Remove ${lock} only after confirming the recorded owner and browser are stopped.`);
    }
    try { await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, profileDir, createdAt: new Date().toISOString() }) + "\n", { mode: 0o600 }); }
    catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
    return new BrowserProcessLauncher({ ...options, profileDir }, kind, command, lock, display);
  }

  start(): Promise<NativeBrowserProcess> {
    if (this.closed) return Promise.reject(new Error("The browser launcher is closed"));
    if (this.starting) return this.starting;
    if (this.current && this.current.child.exitCode === null && this.current.child.signalCode === null) {
      return Promise.reject(new Error("The owned browser process is already running"));
    }
    const starting = this.launch();
    this.starting = starting;
    void starting.finally(() => { if (this.starting === starting) this.starting = undefined; }).catch(() => {});
    return starting;
  }

  private async launch(): Promise<NativeBrowserProcess> {
    const options = this.options;
    const args = this.kind === "chromium" ? [
      "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${options.profileDir}`, "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-gpu",
      // A fresh headed profile can otherwise get a zero-sized content viewport
      // from X11's default geometry, leaving screenshot requests hung indefinitely.
      ...(!options.headless ? ["--window-size=1280,900"] : []), ...(options.chromiumArgs ?? []),
    ] : ["--new-instance", "--profile", options.profileDir,
      "--remote-debugging-port=0", "--remote-allow-hosts", "localhost,127.0.0.1"];
    if (options.headless) args.push(this.kind === "chromium" ? "--headless=new" : "--headless");
    if (this.kind === "chromium") {
      if (options.noSandbox) args.push("--no-sandbox");
      if (this.display === "wayland" || this.display === "x11") args.push(`--ozone-platform=${this.display}`);
    }
    // Pin the reachable display. Inherited Wayland/GTK preferences can otherwise
    // choose a stale socket even though the X11 probe succeeded (and vice versa).
    const env = { ...process.env };
    if (this.display === "x11") {
      delete env.WAYLAND_DISPLAY;
      env.MOZ_ENABLE_WAYLAND = "0";
      env.GDK_BACKEND = "x11";
    } else if (this.display === "wayland") {
      delete env.DISPLAY;
      env.MOZ_ENABLE_WAYLAND = "1";
      env.GDK_BACKEND = "wayland";
    }
    args.push("about:blank");
    const started = Date.now();
    const child = spawn(this.command, args, { env, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    this.startingChild = child;
    let stderr = "";
    let spawnError: Error | undefined;
    child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-16_000); });
    child.once("error", error => { spawnError = error; });
    try {
      while (Date.now() - started < 15_000) {
        if (this.closed) throw new Error("The browser launcher closed during startup");
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new BrowserLaunchError(`${this.kind === "chromium" ? "Chromium" : "Firefox"} exited during startup; ask the host operator to inspect browser diagnostics.`, stderr.trim());
        }
        let endpoint: string | undefined;
        if (this.kind === "chromium") {
          const activePort = path.join(options.profileDir, "DevToolsActivePort");
          try {
            if ((await stat(activePort)).mtimeMs >= started - 1) {
              const [portText, socketPath] = (await readFile(activePort, "utf8")).trim().split("\n");
              const port = Number(portText);
              if (Number.isInteger(port) && port > 0 && port < 65536 && socketPath?.startsWith("/devtools/browser/")) {
                endpoint = `ws://127.0.0.1:${port}${socketPath}`;
              }
            }
          } catch { /* Process has not published a fresh endpoint yet. */ }
        } else {
          const match = stderr.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/);
          if (match) {
            const url = new URL(match[1]!);
            if (!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Firefox debugging endpoint is not loopback-only");
            endpoint = `${url.origin}/session`;
          }
        }
        if (endpoint) {
          const runtime: NativeBrowserProcess = { kind: this.kind, child, endpoint };
          this.current = runtime;
          await writeFile(path.join(this.lock, "owner.json"), JSON.stringify({
            pid: process.pid, browserPid: child.pid, browser: this.kind,
            profileDir: options.profileDir, createdAt: new Date(started).toISOString(),
          }) + "\n", { mode: 0o600 });
          return runtime;
        }
        await delay(25);
      }
      throw new BrowserLaunchError(`${this.kind} did not publish a debugging endpoint; ask the host operator to inspect browser diagnostics.`, stderr.trim());
    } catch (error) {
      await this.stopChild(child);
      throw error;
    } finally { if (this.startingChild === child) this.startingChild = undefined; }
  }

  stop(runtime: NativeBrowserProcess): Promise<void> {
    if (this.current === runtime) this.current = undefined;
    return this.stopChild(runtime.child);
  }

  private stopChild(child: ChildProcess): Promise<void> {
    const stopped = this.stopped.get(child);
    if (stopped) return stopped;
    const operation = (async () => {
      // A reaped process handle cannot prove ownership of a reused numeric PGID.
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const signal = (value: NodeJS.Signals) => {
        try { if (process.platform === "win32") child.kill(value); else process.kill(-child.pid!, value); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      signal("SIGTERM");
      const timer = setTimeout(() => signal("SIGKILL"), 2_000);
      try { await exited; }
      finally { clearTimeout(timer); signal("SIGKILL"); }
    })();
    this.stopped.set(child, operation);
    return operation;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const child = this.current?.child ?? this.startingChild;
      if (child) await this.stopChild(child);
      await this.starting?.catch(() => {});
      this.current = undefined;
      await rm(this.lock, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
