import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerWebBackendCommand, WEB_BACKEND_ENTRY } from "../src/backend-command.ts";
import { createWebTools } from "../src/web/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function harness(manager: SessionManager) {
  const web = createWebTools({ settings: { backend: "browser" } });
  const commands = new Map<string, Command>();
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const notifications: string[] = [];
  const statuses: string[] = [];
  const choices: string[][] = [];
  let selection: number | undefined;
  const pi = {
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => hooks.set(name, handler),
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    sendMessage: (message: { content: string }) => notifications.push(message.content),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    sessionManager: manager,
    ui: {
      setStatus: (_key: string, text: string) => statuses.push(text),
      notify: (text: string) => notifications.push(text),
      select: async (_title: string, items: string[]) => { choices.push(items); return selection === undefined ? undefined : items[selection]; },
    },
  } as unknown as ExtensionCommandContext;
  registerWebBackendCommand(pi, () => web);
  const command = commands.get("web-backend")!;
  return {
    web, notifications, statuses, choices, ctx, command,
    choose(index: number | undefined) { selection = index; },
    run: (args = "") => command.handler(args, ctx),
    refresh: () => hooks.get("session_start")!({}, ctx),
    tree: () => hooks.get("session_tree")!({}, ctx),
  };
}

test("backend command picks, validates, reports and resets without changing environment or tools", async () => {
  const environment = process.env.PI_WEB_BACKEND;
  const manager = SessionManager.inMemory();
  const host = harness(manager);
  try {
    const tools = host.web.tools;
    await host.refresh();
    assert.equal(host.web.getBackendState().effective, "browser");
    await host.run("codex");
    assert.equal(host.web.getBackendState().effective, "codex");
    assert.equal(host.web.getBackendState().source, "override");
    assert.equal(host.statuses.at(-1), "web:codex*");
    assert.equal(host.web.tools, tools);
    const count = manager.getEntries().length;
    await host.run("status");
    await host.run("codex");
    await host.run(); // Dismiss picker.
    assert.equal(manager.getEntries().length, count);
    await assert.rejects(host.run("invalid"), /Usage: \/web-backend/);
    assert.equal(host.web.getBackendState().effective, "codex");
    host.choose(1);
    await host.run();
    assert.equal(host.web.getBackendState().effective, "auto");
    assert.match(host.choices.at(-1)![1], /Codex first/);
    host.choose(0);
    await host.run();
    assert.deepEqual(host.web.getBackendState(), { configured: "browser", effective: "browser", override: null, source: "host" });
    assert.equal(host.statuses.at(-1), "web:browser");
    assert.match(host.notifications.at(-1)!, /active requests are unchanged/);
    host.ctx.hasUI = false;
    await host.run();
    assert.match(host.notifications.at(-1)!, /Configured default: browser/);
    assert.equal(process.env.PI_WEB_BACKEND, environment);
    const completions = await host.command.getArgumentCompletions?.("co");
    assert.deepEqual(completions, [{ value: "codex", label: "codex" }]);
  } finally { await host.web.close(); }
});

test("override survives disk resume/reload and forks, follows tree branches, and New uses its default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-backend-command-"));
  const manager = SessionManager.create(root, root);
  manager.appendMessage(fauxAssistantMessage("Persist a local fixture session; no inference."));
  const baseline = manager.getLeafId()!;
  const original = harness(manager);
  const hosts = [original];
  try {
    await original.refresh();
    await original.run("codex");
    const codexLeaf = manager.getLeafId()!;
    const filename = manager.getSessionFile()!;
    const resumed = harness(SessionManager.open(filename));
    hosts.push(resumed);
    await resumed.refresh();
    assert.equal(resumed.web.getBackendState().effective, "codex");
    const reloaded = harness(manager);
    hosts.push(reloaded);
    await reloaded.refresh();
    assert.equal(reloaded.web.getBackendState().effective, "codex");
    manager.branch(baseline);
    await original.tree();
    assert.equal(original.web.getBackendState().effective, "browser");
    await original.run("auto");
    manager.branch(codexLeaf);
    await original.tree();
    assert.equal(original.web.getBackendState().effective, "codex", "abandoned branch overrides are ignored");
    manager.appendCustomEntry(WEB_BACKEND_ENTRY, { backend: "invalid" });
    await original.tree();
    assert.equal(original.web.getBackendState().effective, "codex", "malformed state is not accepted");
    manager.createBranchedSession(codexLeaf);
    const fork = harness(manager);
    hosts.push(fork);
    await fork.refresh();
    assert.equal(fork.web.getBackendState().effective, "codex");
    await fork.run("reset");
    const cleared = harness(manager);
    hosts.push(cleared);
    await cleared.refresh();
    assert.equal(cleared.web.getBackendState().override, null);
    const fresh = harness(SessionManager.inMemory());
    hosts.push(fresh);
    await fresh.refresh();
    assert.equal(fresh.web.getBackendState().effective, "browser");
    assert.equal(fresh.web.getBackendState().override, null);
  } finally {
    await Promise.all(hosts.map(host => host.web.close()));
    await rm(root, { recursive: true, force: true });
  }
});
