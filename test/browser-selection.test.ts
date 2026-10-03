import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { browserHeadless, browserSource, createBrowserSelection, firefoxDefaultProfile, parseBrowserChoice } from "../src/browser-selection.ts";

test("browser choices validate names and remote syntax", () => {
  for (const value of ["chromium", "firefox", "firefox-default-profile", "remote:void-flip", "remote:a.b_c-1"]) assert.equal(parseBrowserChoice(value), value);
  for (const value of ["", "Chromium", "chrome", "remote", "remote:", "remote:../escape", "remote:-x", "remote void-flip"]) {
    assert.throws(() => parseBrowserChoice(value), /must be|simple name/);
  }
});

test("PI_BROWSER configures the default; session overrides never mutate the environment", () => {
  assert.deepEqual(createBrowserSelection({}).getState(), { configured: "chromium", override: null, effective: "chromium", source: "default" });
  const environment: NodeJS.ProcessEnv = { PI_BROWSER: "remote:desk" };
  const selection = createBrowserSelection(environment);
  assert.deepEqual(selection.getState(), { configured: "remote:desk", override: null, effective: "remote:desk", source: "environment" });
  selection.setOverride("firefox-default-profile");
  assert.deepEqual(selection.getState(), { configured: "remote:desk", override: "firefox-default-profile", effective: "firefox-default-profile", source: "override" });
  assert.throws(() => selection.setOverride("opera" as "firefox"), /must be/);
  assert.equal(selection.getState().effective, "firefox-default-profile");
  selection.setOverride(null);
  assert.equal(selection.getState().effective, "remote:desk");
  assert.deepEqual(environment, { PI_BROWSER: "remote:desk" });
  assert.throws(() => createBrowserSelection({ PI_BROWSER: "firefox-primary-user" }), /must be/);
});

test("PI_BROWSER_HEADLESS accepts only explicit booleans", () => {
  assert.equal(browserHeadless({}), false);
  for (const value of ["1", "true"]) assert.equal(browserHeadless({ PI_BROWSER_HEADLESS: value }), true);
  for (const value of ["0", "false"]) assert.equal(browserHeadless({ PI_BROWSER_HEADLESS: value }), false);
  assert.throws(() => browserHeadless({ PI_BROWSER_HEADLESS: "yes" }), /PI_BROWSER_HEADLESS/);
});

test("firefox default profile follows profiles.ini without guessing", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-browser-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".mozilla", "firefox");
  await assert.rejects(firefoxDefaultProfile(home), /No Firefox profiles\.ini/);
  await mkdir(root, { recursive: true });
  const ini = (text: string) => writeFile(path.join(root, "profiles.ini"), text);
  const profiles = "[Profile1]\nName=default\nIsRelative=1\nPath=old.default\nDefault=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=new.default-release\n\n[General]\nStartWithLastProfile=1\n";
  await ini(`[Install4F96D1932A9F858E]\nDefault=new.default-release\nLocked=1\n\n${profiles}`);
  assert.equal(await firefoxDefaultProfile(home), path.join(root, "new.default-release"), "the install default wins");
  await ini(profiles);
  assert.equal(await firefoxDefaultProfile(home), path.join(root, "old.default"), "Default=1 is the fallback");
  await ini("[Profile0]\r\nIsRelative=0\r\nPath=/srv/firefox/profile\r\nDefault=1\r\n");
  assert.equal(await firefoxDefaultProfile(home), "/srv/firefox/profile");
  await ini(`[InstallA]\nDefault=a\n[InstallB]\nDefault=b\n${profiles}`);
  await assert.rejects(firefoxDefaultProfile(home), /2 install defaults; the default profile is ambiguous/);
  await ini("[Profile0]\nPath=a\nDefault=1\n[Profile1]\nPath=b\nDefault=1\n");
  await assert.rejects(firefoxDefaultProfile(home), /several default profiles/);
  await ini("[Profile0]\nPath=a\n[General]\nVersion=2\n");
  await assert.rejects(firefoxDefaultProfile(home), /no default profiles/);
});

test("browser sources: stable Pi profiles per engine and named remote sockets", async t => {
  const agent = await mkdtemp(path.join(tmpdir(), "pi-browser-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agent, { recursive: true, force: true });
  });
  const profiles = path.join(agent, "browser", "profiles");
  assert.deepEqual(await browserSource("chromium", profiles, true), { browser: "chromium", profileDir: path.join(profiles, "chromium"), headless: true });
  assert.deepEqual(await browserSource("firefox", profiles, false), { browser: "firefox", profileDir: path.join(profiles, "firefox"), headless: false });
  assert.deepEqual(await browserSource("remote:desk", profiles, true), { remote: "desk", socketPath: path.join(agent, "browser-sockets", "desk.sock") });
  assert.equal((await stat(path.join(agent, "browser-sockets"))).mode & 0o777, 0o700);
});
