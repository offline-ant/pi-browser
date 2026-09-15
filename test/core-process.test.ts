import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { BrowserProcessLauncher } from "../src/core/process.ts";
import { launchBrowser } from "../src/core/index.ts";
import { Cdp } from "../src/core/cdp.ts";
import { Bidi } from "../src/core/bidi.ts";

// These checks never need a real browser: profile leases and launch failures are host behavior.
test("profile ownership is exclusive, resolves aliases and releases after close", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-profile-"));
  const profile = path.join(root, "profile");
  const settings = { profileDir: profile, executable: "/bin/false", headless: true };
  const first = await BrowserProcessLauncher.create(settings);
  t.after(async () => { await first.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(BrowserProcessLauncher.create(settings), /already owned/);
  await symlink(profile, path.join(root, "alias"), "dir");
  await assert.rejects(BrowserProcessLauncher.create({ ...settings, profileDir: path.join(root, "alias") }), /already owned/);
  const owner = JSON.parse(await readFile(path.join(profile, ".pi-browser-owner", "owner.json"), "utf8")) as { pid: number };
  assert.equal(owner.pid, process.pid);
  await first.close();
  await first.close();
  const next = await BrowserProcessLauncher.create(settings);
  await next.close();
  await assert.rejects(first.start(), /closed/);
});

test("failed launch releases the profile and does not signal a reaped process group", async t => {
  const profile = await mkdtemp(path.join(tmpdir(), "pi-browser-failed-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const kill = process.kill.bind(process);
  const groups: number[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < 0) groups.push(pid);
    return kill(pid, signal);
  });
  for (const browser of ["chromium", "firefox"] as const) {
    await assert.rejects(launchBrowser({ browser, profileDir: profile, executable: "/bin/false", headless: true }), /exited during startup/);
    await assert.rejects(readFile(path.join(profile, ".pi-browser-owner", "owner.json")), { code: "ENOENT" });
  }
  assert.deepEqual(groups, []);
});

test("headless is explicit; stale or absent display settings never hide a requested window", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-display-"));
  const previous = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  process.env.DISPLAY = ":999999";
  process.env.WAYLAND_DISPLAY = "absent-display";
  process.env.XDG_RUNTIME_DIR = root;
  await assert.rejects(BrowserProcessLauncher.create({ profileDir: root, executable: "/bin/false" }), /No graphical display is reachable/);
  const allowed = await BrowserProcessLauncher.create({ profileDir: root, executable: "/bin/false", headless: true });
  await allowed.close();
});

test("headed launch pins the reachable display instead of stale inherited browser preferences", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-display-choice-"));
  const previous = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  const x11 = createServer(socket => socket.end());
  const wayland = createServer(socket => socket.end());
  await new Promise<void>(resolve => x11.listen(0, "127.0.0.1", resolve));
  const address = x11.address();
  assert(address && typeof address !== "string" && address.port > 6000);
  await new Promise<void>(resolve => wayland.listen(path.join(root, "wayland-live"), resolve));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await Promise.all([x11, wayland].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  });
  const captured = path.join(root, "captured.json");
  const executable = path.join(root, "browser-fixture");
  await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify({args:process.argv.slice(2),display:process.env.DISPLAY,wayland:process.env.WAYLAND_DISPLAY,gtk:process.env.GDK_BACKEND,moz:process.env.MOZ_ENABLE_WAYLAND}));\n`, { mode: 0o700 });
  process.env.XDG_RUNTIME_DIR = root;
  for (const display of ["x11", "wayland"] as const) {
    process.env.DISPLAY = display === "x11" ? `127.0.0.1:${address.port - 6000}` : ":999999";
    process.env.WAYLAND_DISPLAY = display === "wayland" ? "wayland-live" : "wayland-missing";
    for (const browser of ["chromium", "firefox"] as const) {
      const launcher = await BrowserProcessLauncher.create({ browser, profileDir: path.join(root, browser), executable });
      try {
        await assert.rejects(launcher.start(), /exited during startup/);
        const result = JSON.parse(await readFile(captured, "utf8"));
        assert.equal(result.gtk, display);
        assert.equal(result.moz, display === "wayland" ? "1" : "0");
        assert.equal(result.args.some((arg: string) => arg.startsWith("--headless")), false);
        if (browser === "chromium") {
          assert(result.args.includes(`--ozone-platform=${display}`));
          assert(result.args.includes("--window-size=1280,900"));
          assert(!result.args.includes("--no-sandbox"));
        }
        assert.equal(display === "x11" ? result.wayland : result.display, undefined);
      } finally { await launcher.close(); }
    }
  }
});

test("Linux abstract X11 is usable without a filesystem socket and with unavailable Wayland", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-abstract-x11-"));
  const previous = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  const number = randomInt(10_000_000, 100_000_000);
  const socketPath = `/tmp/.X11-unix/X${number}`;
  const x11 = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    x11.once("error", reject);
    x11.listen(`\0${socketPath}`, resolve);
  });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => x11.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(readFile(socketPath), { code: "ENOENT" });
  process.env.XDG_RUNTIME_DIR = root;
  process.env.WAYLAND_DISPLAY = "unavailable-wayland";
  for (const display of [`:${number}`, `unix:${number}.0`]) {
    process.env.DISPLAY = display;
    for (const browser of ["firefox", "chromium"] as const) {
      // Regression: the old filesystem-only probe rejects this before spawning.
      const launcher = await BrowserProcessLauncher.create({ browser, profileDir: path.join(root, browser), executable: "/bin/false" });
      try { await assert.rejects(launcher.start(), /exited during startup/); }
      finally { await launcher.close(); }
    }
  }
});

test("shutdown interrupts incomplete startup and retains its lease until the process stops", { timeout: 10_000, skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-starting-"));
  const executable = path.join(root, "browser-fixture");
  const profileDir = path.join(root, "profile");
  await writeFile(executable, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n", { mode: 0o700 });
  const settings = { profileDir, executable, headless: true };
  const launcher = await BrowserProcessLauncher.create(settings);
  t.after(async () => { await launcher.close(); await rm(root, { recursive: true, force: true }); });
  const starting = launcher.start();
  const rejected = assert.rejects(starting, /closed during startup/);
  await delay(150);
  const start = Date.now();
  const closing = launcher.close();
  await assert.rejects(BrowserProcessLauncher.create(settings), /already owned/);
  await closing;
  await rejected;
  assert(Date.now() - start < 5_000, "shutdown must not wait for the startup deadline");
  const replacement = await BrowserProcessLauncher.create(settings);
  await replacement.close();
});

test("Firefox sandbox stays enabled and debug transports reject non-loopback endpoints", async () => {
  await assert.rejects(BrowserProcessLauncher.create({ browser: "firefox", profileDir: "/unused", headless: true, noSandbox: true }), /noSandbox/);
  await assert.rejects(Cdp.connect("ws://example.com/devtools/browser/unsafe"), /loopback-only/);
  await assert.rejects(Bidi.connect("ws://example.com/session"), /loopback-only/);
});
