import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBrowser, type BrowserKind, type BrowserSession } from "./core/index.ts";
import { publicBrowserError } from "./core/process.ts";
import { abortable } from "./web/async.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function validateRemote(name: string): void {
  if (!NAME.test(name)) throw new Error("Browser remote must be a simple name: 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.");
}

function remoteDirectory(create: boolean): string {
  const directory = path.resolve(getAgentDir(), "browser-sockets");
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error("The browser-sockets directory must be a private directory (mode 0700), not a symlink. Ask the host operator to repair it.");
  }
  return directory;
}

export function remoteSocketPath(name: string): string {
  validateRemote(name);
  return path.join(remoteDirectory(true), `${name}.sock`);
}

export type BrowserSetupHandler = (instructions: string, signal: AbortSignal) => Promise<boolean>;

/** Retry only connection setup, never navigation or evaluation. */
export async function connectRemote(remote: string, browser: BrowserKind, signal: AbortSignal, setup?: BrowserSetupHandler): Promise<BrowserSession> {
  const socketPath = remoteSocketPath(remote);
  const attempt = async () => {
    signal.throwIfAborted();
    const owner = await connectBrowser({ browser, socketPath, signal });
    if (signal.aborted) {
      await owner.close();
      signal.throwIfAborted();
    }
    return owner;
  };
  // Transport diagnostics can include the Unix path; receipts use the name only.
  const reason = (error: unknown) => publicBrowserError(error).replaceAll(socketPath, `remote ${remote}`);
  try { return await attempt(); }
  catch (error) {
    signal.throwIfAborted();
    const instructions = `Could not connect to remote ${remote} (${browser}): ${reason(error)}\nRun /browser-remote-setup [pi-ssh-target] in Pi for publisher-side instructions (the remote name is the publisher hostname), or restore the existing publisher tunnel and dedicated browser on port 9222. Do not restart a busy browser or remove a live socket. No local fallback is used.`;
    const confirmed = setup && await abortable(setup(instructions, signal), signal);
    signal.throwIfAborted();
    if (!confirmed) throw new Error(`${instructions}\n${setup ? "Retry was declined." : "No interactive setup confirmation is available."}`);
    try { return await attempt(); }
    catch (retryError) {
      signal.throwIfAborted();
      throw new Error(`Remote ${remote} connection failed after the confirmed retry: ${reason(retryError)}\n${instructions}`);
    }
  }
}

export function remoteNames(): string[] {
  let directory: string;
  try { directory = remoteDirectory(false); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isSocket() && entry.name.endsWith(".sock") && NAME.test(entry.name.slice(0, -5)))
    .map(entry => entry.name.slice(0, -5)).sort();
}

// Close single quotes around escapes so both sh and fish preserve backslashes.
function quote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/['\\]/g, character => `'\\${character}'`)}'`;
}

export function registerBrowserRemoteSetup(pi: ExtensionAPI): void {
  pi.registerCommand("browser-remote-setup", {
    description: "Install the publisher helper and print its command: [pi-ssh-target]",
    async handler(args) {
      const username = userInfo().username;
      let target = args.trim() || `${username}@${hostname()}`;
      if (target.startsWith("-") || /[\s\u0000-\u001f\u007f]/u.test(target)) {
        throw new Error("Usage: /browser-remote-setup [pi-ssh-target] — use a Pi host SSH alias, IP, or user@host reachable from the publisher.");
      }
      if (!target.includes("@")) target = `${username}@${target}`;
      const directory = remoteDirectory(true);
      const helper = path.resolve(getAgentDir(), "browser-open");
      const template = readFileSync(new URL("../bin/browser-open", import.meta.url), "utf8");
      writeFileSync(helper, template
        .replace("__PI_BROWSER_SOCKET_DIRECTORY__", () => quote(directory))
        .replace("__PI_BROWSER_SSH_TARGET__", () => quote(target)), { mode: 0o700 });
      chmodSync(helper, 0o700);
      const names = remoteNames();
      const command = `ssh ${quote(target)} ${quote(`cat ${quote(helper)}`)} | sh`;
      pi.sendMessage({ customType: "pi-browser:remote-setup", display: true, content: [
        `Pi SSH target: ${target}. Override with /browser-remote-setup <pi-ssh-target> if this address is not reachable from the publisher.`,
        `Discovered socket names: ${names.length ? names.join(", ") : "none"}. The publisher derives its remote name from hostname (for example, void-flip); no name argument or registry is needed.`,
        "Run ON the publisher in a real desktop terminal as its desktop user (requires Firefox, curl, ssh, and standard ps/awk). The helper always uses Firefox, independently of /browser-default.",
        `\`\`\`sh\n${command}\n\`\`\``,
        "Setup embeds this receiver target and its fixed socket directory in the helper; rerunning setup replaces those defaults. The target is optional when running the helper: append -s -- user@other-address after sh only to override it.",
        "The helper uses only $HOME/.local/share/pi-browser/firefox-9222. It reuses that user's Firefox process with this exact profile and debugging port 9222, or launches it if absent. An unverified listener or a busy profile without debugging is an error, not a reason to attach elsewhere. It never stops or restarts a browser. Keep the tunnel in the foreground; Ctrl+C closes the tunnel, not the browser.",
        'Use browser({remote:"<publisher-hostname>",browser:"firefox"}), or start Pi with PI_BROWSER_REMOTE=<publisher-hostname> PI_WEB_BROWSER=firefox.',
        "Debug access is browser-wide: trust the Pi host and keep port 9222 loopback-only. If SSH reports a stale socket, confirm its old tunnel has stopped before manually removing only that socket on the Pi host and rerunning the publisher command. No automatic unlink or sudo is performed.",
      ].join("\n\n") });
    },
  });
}
