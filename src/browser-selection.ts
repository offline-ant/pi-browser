import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { BrowserSource } from "./broker/protocol.ts";
import { remoteSocketPath, validateRemote } from "./browser-remote.ts";

/** The one browser that `browser`, `web_search`, and `web_fetch` share. */
export type BrowserChoice = "chromium" | "firefox" | "firefox-default-profile" | `remote:${string}`;

export interface BrowserSelectionState {
  configured: BrowserChoice;
  override: BrowserChoice | null;
  effective: BrowserChoice;
  source: "override" | "environment" | "default";
}

export interface BrowserSelection {
  getState(): BrowserSelectionState;
  setOverride(value: BrowserChoice | null): void;
}

export function parseBrowserChoice(value: string): BrowserChoice {
  if (value === "chromium" || value === "firefox" || value === "firefox-default-profile") return value;
  if (value.startsWith("remote:")) {
    validateRemote(value.slice("remote:".length));
    return value as BrowserChoice;
  }
  throw new Error("Browser must be chromium | firefox | firefox-default-profile | remote:<name>.");
}

export function createBrowserSelection(environment: NodeJS.ProcessEnv = process.env): BrowserSelection {
  const configured = parseBrowserChoice(environment.PI_BROWSER ?? "chromium");
  const source = environment.PI_BROWSER === undefined ? "default" : "environment";
  let override: BrowserChoice | null = null;
  return {
    getState: () => ({ configured, override, effective: override ?? configured, source: override === null ? source : "override" }),
    setOverride(value) { override = value === null ? null : parseBrowserChoice(value); },
  };
}

export function browserHeadless(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.PI_BROWSER_HEADLESS;
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("PI_BROWSER_HEADLESS must be true, false, 1, or 0.");
}

/** `x11Display`: the display for locally launched headed browsers, for example a virtual `:99`; unset detects the desktop's display. */
export interface LocalLaunch { headless: boolean; x11Display?: string }

/** Pi-owned profiles are stable across sessions; the default profile is this user's own Firefox profile. */
export async function browserSource(choice: BrowserChoice, profiles: string, launch: LocalLaunch): Promise<BrowserSource> {
  if (choice.startsWith("remote:")) {
    const remote = choice.slice("remote:".length);
    return { remote, socketPath: remoteSocketPath(remote) };
  }
  const profileDir = choice === "firefox-default-profile" ? await firefoxDefaultProfile() : path.join(profiles, choice);
  const browser = choice === "chromium" ? "chromium" : "firefox";
  // Headless browsers use no display.
  return { browser, profileDir, headless: launch.headless, ...(launch.headless || launch.x11Display === undefined ? {} : { x11Display: launch.x11Display }) };
}

/** profiles.ini: the single install default, else the single profile marked Default=1. */
export async function firefoxDefaultProfile(home = homedir()): Promise<string> {
  const root = path.join(home, ".mozilla", "firefox");
  let text: string;
  try { text = await readFile(path.join(root, "profiles.ini"), "utf8"); }
  catch { throw new Error(`No Firefox profiles.ini in ${root}; start Firefox once to create its default profile.`); }
  const sections: { name: string; values: Map<string, string> }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[(.+)\]\s*$/);
    if (header) sections.push({ name: header[1]!, values: new Map() });
    else {
      const pair = line.match(/^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/);
      if (pair && sections.length) sections.at(-1)!.values.set(pair[1]!, pair[2]!);
    }
  }
  const installs = sections.filter(section => section.name.startsWith("Install") && section.values.get("Default"));
  if (installs.length > 1) throw new Error(`Firefox profiles.ini has ${installs.length} install defaults; the default profile is ambiguous.`);
  if (installs.length === 1) return path.resolve(root, installs[0]!.values.get("Default")!);
  const defaults = sections.filter(section => section.name.startsWith("Profile") && section.values.get("Default") === "1" && section.values.get("Path"));
  if (defaults.length !== 1) throw new Error(`Firefox profiles.ini has ${defaults.length ? "several" : "no"} default profiles; the default profile is ambiguous.`);
  const profile = defaults[0]!.values;
  return profile.get("IsRelative") === "0" ? profile.get("Path")! : path.resolve(root, profile.get("Path")!);
}
