import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BROWSER_ENTRY, registerBrowserCommand } from "../src/browser-command.ts";
import { createBrowserSelection } from "../src/browser-selection.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function harness(manager: SessionManager) {
  const browser = createBrowserSelection({});
  const commands = new Map<string, Command>();
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const notifications: string[] = [];
  const messages: string[] = [];
  const statuses: { key: string; text: string }[] = [];
  const choices: string[][] = [];
  let selection: number | undefined;
  const pi = {
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => hooks.set(name, handler),
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    sessionManager: manager,
    ui: {
      setStatus: (key: string, text: string) => statuses.push({ key, text }),
      notify: (text: string) => notifications.push(text),
      select: async (_title: string, items: string[]) => { choices.push(items); return selection === undefined ? undefined : items[selection]; },
    },
  } as unknown as ExtensionCommandContext;
  registerBrowserCommand(pi, () => browser);
  const command = commands.get("browser")!;
  return {
    browser, notifications, messages, statuses, choices, ctx, command,
    choose(index: number | undefined) { selection = index; },
    run: (args = "") => command.handler(args, ctx),
    refresh: () => hooks.get("session_start")!({}, ctx),
    tree: () => hooks.get("session_tree")!({}, ctx),
    input: () => hooks.get("input")!({}, ctx),
  };
}

async function agentDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("/browser picks, validates, reports and resets, including remotes", async t => {
  const root = await agentDirectory(t);
  // A published socket makes its remote appear in the picker and completions.
  await mkdir(path.join(root, "browser-sockets"), { mode: 0o700 });
  const published = createServer();
  await new Promise<void>(resolve => published.listen(path.join(root, "browser-sockets", "desk.sock"), resolve));
  t.after(() => new Promise<void>(resolve => published.close(() => resolve())));
  const manager = SessionManager.inMemory();
  const host = harness(manager);
  await host.refresh();
  assert.deepEqual(host.statuses.at(-1), { key: "browser", text: "browser:chromium" });
  await host.run(" firefox ");
  assert.equal(host.browser.getState().effective, "firefox");
  assert.deepEqual(host.statuses.at(-1), { key: "browser", text: "browser:firefox*" });
  const count = manager.getEntries().length;
  await host.run("status");
  await host.run("firefox");
  await host.run(); // Dismissed picker.
  assert.equal(manager.getEntries().length, count, "unchanged selections append nothing");
  await assert.rejects(host.run("chrome"), /Usage: \/browser \[chromium\|firefox\|firefox-default-profile\|remote <name>\|reset\|status\]/);
  await assert.rejects(host.run("remote"), /Usage: \/browser/);
  await assert.rejects(host.run("remote ../escape"), /simple name/);
  await host.run("remote   desk");
  assert.equal(host.browser.getState().effective, "remote:desk");
  assert.deepEqual(host.statuses.at(-1), { key: "browser", text: "browser:remote desk*" });
  host.choose(3);
  await host.run();
  assert.deepEqual(host.choices.at(-1), ["Use configured browser (chromium)", "Chromium (stable Pi profile)", "Firefox (stable Pi profile)",
    "Firefox default profile (this user's own; logged-in pages are visible to the agent)", "Remote desk"]);
  assert.equal(host.browser.getState().effective, "firefox-default-profile");
  host.choose(4);
  await host.run();
  assert.equal(host.browser.getState().effective, "remote:desk");
  host.choose(0);
  await host.run();
  assert.deepEqual(host.browser.getState(), { configured: "chromium", override: null, effective: "chromium", source: "default" });
  assert.match(host.notifications.at(-1)!, /Applies to future browser, web_search, and web_fetch calls; open tabs and running calls are unchanged/);
  const pickerCount = host.choices.length;
  host.ctx.hasUI = false;
  await host.run();
  assert.equal(host.choices.length, pickerCount, "non-UI invocation reports instead of prompting");
  assert.match(host.messages.at(-1)!, /Browser: chromium \(default\)/);
  assert.deepEqual(await host.command.getArgumentCompletions?.("fi"), [
    { value: "firefox", label: "firefox" }, { value: "firefox-default-profile", label: "firefox-default-profile" }]);
  assert.deepEqual(await host.command.getArgumentCompletions?.("re"), [
    { value: "remote desk", label: "remote desk" }, { value: "reset", label: "reset" }]);
});

test("/browser follows the session branch across resume, reload, tree navigation and forks", async t => {
  const root = await agentDirectory(t);
  const manager = SessionManager.create(root, root);
  manager.appendMessage(fauxAssistantMessage("Persist a local fixture session; no inference."));
  const baseline = manager.getLeafId()!;
  const original = harness(manager);
  await original.refresh();
  await original.run("remote desk");
  assert.deepEqual(manager.getEntries().filter(entry => entry.type === "custom").map(entry => entry.type === "custom" && [entry.customType, entry.data]),
    [[BROWSER_ENTRY, { browser: "remote:desk" }]]);
  const remoteLeaf = manager.getLeafId()!;
  const resumed = harness(SessionManager.open(manager.getSessionFile()!));
  await resumed.refresh();
  assert.equal(resumed.browser.getState().effective, "remote:desk");
  manager.branch(baseline);
  await original.tree();
  assert.equal(original.browser.getState().override, null);
  await original.run("firefox");
  manager.branch(remoteLeaf);
  await original.tree();
  assert.equal(original.browser.getState().effective, "remote:desk", "abandoned branch overrides are ignored");
  original.browser.setOverride("chromium");
  await original.input();
  assert.equal(original.browser.getState().effective, "remote:desk", "input restores authoritative branch state");
  manager.createBranchedSession(remoteLeaf);
  const fork = harness(manager);
  await fork.refresh();
  assert.equal(fork.browser.getState().effective, "remote:desk");
  await fork.run("reset");
  const cleared = harness(manager);
  await cleared.refresh();
  assert.equal(cleared.browser.getState().override, null, "reset clears earlier persisted overrides");
  const fresh = harness(SessionManager.inMemory());
  await fresh.refresh();
  assert.equal(fresh.browser.getState().effective, "chromium");
});
