import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BROWSER_DEFAULT_ENTRY, registerBrowserDefaultCommand } from "../src/browser-default-command.ts";
import { createBrowserDefault } from "../src/browser-default.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function harness(manager: SessionManager) {
  const browser = createBrowserDefault({ browser: "chromium" }, {});
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
  registerBrowserDefaultCommand(pi, () => browser);
  const command = commands.get("browser-default")!;
  return {
    browser, notifications, messages, statuses, choices, ctx, command,
    choose(index: number | undefined) { selection = index; },
    run: (args = "") => command.handler(args, ctx),
    refresh: () => hooks.get("session_start")!({}, ctx),
    tree: () => hooks.get("session_tree")!({}, ctx),
    input: () => hooks.get("input")!({}, ctx),
  };
}

test("browser-default picks, validates, reports and resets without changing environment", async () => {
  const environment = process.env.PI_WEB_BROWSER;
  const manager = SessionManager.inMemory();
  const host = harness(manager);
  await host.refresh();
  assert.equal(host.browser.getState().effective, "chromium");
  await host.run(" firefox ");
  assert.equal(host.browser.getState().effective, "firefox");
  assert.equal(host.browser.getState().source, "override");
  assert.deepEqual(host.statuses.at(-1), { key: "browser-default", text: "browser:firefox*" });
  const count = manager.getEntries().length;
  await host.run("status");
  await host.run("firefox");
  await host.run(); // Dismiss picker.
  assert.equal(manager.getEntries().length, count);
  await assert.rejects(host.run("invalid"), /Usage: \/browser-default/);
  assert.equal(host.browser.getState().effective, "firefox");
  host.choose(1);
  await host.run();
  assert.equal(host.browser.getState().effective, "chromium");
  assert.equal(host.browser.getState().source, "override", "explicit configured value is still an override");
  host.choose(2);
  await host.run();
  assert.equal(host.browser.getState().effective, "firefox");
  assert.deepEqual(host.choices.at(-1), ["Use configured default (chromium)", "Chromium", "Firefox"]);
  host.choose(0);
  await host.run();
  assert.deepEqual(host.browser.getState(), { configured: "chromium", effective: "chromium", override: null, source: "host" });
  assert.deepEqual(host.statuses.at(-1), { key: "browser-default", text: "browser:chromium" });
  assert.match(host.notifications.at(-1)!, /future browser-backed web calls and new browser sessions/);
  assert.match(host.notifications.at(-1)!, /existing sessions and active requests are unchanged/);
  const pickerCount = host.choices.length;
  host.ctx.hasUI = false;
  await host.run();
  assert.equal(host.choices.length, pickerCount, "non-UI invocation reports instead of prompting");
  assert.match(host.messages.at(-1)!, /Configured default: chromium/);
  await host.run("firefox");
  assert.equal(host.browser.getState().effective, "firefox");
  assert.equal(process.env.PI_WEB_BROWSER, environment);
  assert.deepEqual(await host.command.getArgumentCompletions?.("fi"), [{ value: "firefox", label: "firefox" }]);
  assert.deepEqual(await host.command.getArgumentCompletions?.("unknown"), []);
});

test("browser-default survives disk resume/reload and forks, follows branches, and New uses its default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-default-command-"));
  const manager = SessionManager.create(root, root);
  manager.appendMessage(fauxAssistantMessage("Persist a local fixture session; no inference."));
  const baseline = manager.getLeafId()!;
  const original = harness(manager);
  try {
    await original.refresh();
    await original.run("firefox");
    const firefoxLeaf = manager.getLeafId()!;
    const resumed = harness(SessionManager.open(manager.getSessionFile()!));
    await resumed.refresh();
    assert.equal(resumed.browser.getState().effective, "firefox");
    const reloaded = harness(manager);
    await reloaded.refresh();
    assert.equal(reloaded.browser.getState().effective, "firefox");
    manager.branch(baseline);
    await original.tree();
    assert.equal(original.browser.getState().effective, "chromium");
    assert.equal(original.browser.getState().override, null);
    await original.run("chromium");
    manager.branch(firefoxLeaf);
    await original.tree();
    assert.equal(original.browser.getState().effective, "firefox", "abandoned branch overrides are ignored");
    manager.appendCustomEntry(BROWSER_DEFAULT_ENTRY, { browser: "invalid" });
    manager.appendCustomEntry(BROWSER_DEFAULT_ENTRY, null);
    manager.appendCustomEntry(BROWSER_DEFAULT_ENTRY, { backend: "chromium" });
    await original.input();
    assert.equal(original.browser.getState().effective, "firefox", "malformed state is not accepted");
    original.browser.setOverride("chromium");
    await original.input();
    assert.equal(original.browser.getState().effective, "firefox", "input restores authoritative branch state");
    manager.createBranchedSession(firefoxLeaf);
    const fork = harness(manager);
    await fork.refresh();
    assert.equal(fork.browser.getState().effective, "firefox");
    await fork.run("reset");
    const cleared = harness(manager);
    await cleared.refresh();
    assert.equal(cleared.browser.getState().override, null, "reset clears earlier persisted overrides");
    const fresh = harness(SessionManager.inMemory());
    await fresh.refresh();
    assert.equal(fresh.browser.getState().effective, "chromium");
    assert.equal(fresh.browser.getState().override, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
