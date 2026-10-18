import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { firefoxDefaultProfile } from "../src/browser-selection.ts";

const template = await readFile(new URL("../bin/browser-open", import.meta.url), "utf8");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const options = { skip: process.platform !== "linux", timeout: 15_000 };

async function fixture(t: TestContext, platform = "Linux") {
  const home = await mkdtemp(path.join(tmpdir(), "pi publisher-"));
  const bin = path.join(home, "bin");
  const root = path.join(home, platform === "Darwin" ? "Library/Application Support/Firefox" : ".mozilla/firefox");
  const profile = path.join(root, "normal.default");
  const dedicated = path.join(home, ".local/share/pi-browser/firefox-9222");
  await mkdir(bin, { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(root, "profiles.ini"), "[InstallA]\nDefault=normal.default\n");
  await writeFile(path.join(home, "processes"), "");
  t.after(async () => {
    try { process.kill(Number(await readFile(path.join(home, "browser.pid"), "utf8")), "SIGTERM"); } catch { /* No mock was launched, or it exited. */ }
    await rm(home, { recursive: true, force: true });
  });
  const stub = async (name: string, body: string) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o700);
  };
  await stub("uname", `printf '%s\\n' ${quote(platform)}`);
  await stub("hostname", "printf '%s\\n' publisher");
  await stub("ps", '/bin/cat "$HOME/processes"');
  await stub("curl", '[ -f "$HOME/listening" ]');
  await stub("ssh", 'printf "%s\\n" "$@" > "$HOME/ssh.args"');
  // No real browser, network research, profile locks or SSH. The mock listens on
  // an ephemeral loopback port just to stay alive until test cleanup.
  await writeFile(path.join(home, "browser.mjs"), `
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
const home = process.env.HOME;
writeFileSync(home + '/browser.pid', String(process.pid));
writeFileSync(home + '/launch.args', JSON.stringify(process.argv.slice(2)));
writeFileSync(home + '/processes', '/usr/bin/firefox ' + process.argv.slice(2).join(' ') + '\\n');
writeFileSync(home + '/listening', '');
createServer().listen(0, '127.0.0.1');
`);
  await stub("firefox", `exec ${quote(process.execPath)} "$HOME/browser.mjs" "$@"`);
  const helper = path.join(home, "browser-open");
  await writeFile(helper, template.replace("__PI_BROWSER_SOCKET_DIRECTORY__", "/receiver/browser-sockets")
    .replace("__PI_BROWSER_SSH_TARGET__", "claude@voidpc"));
  const environment = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const run = (choice: string, confirmation?: string, beforeConfirmation?: () => Promise<void>) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    // Real controlling terminal, while sh reads its program from a pipe exactly
    // like the public fetch command. Prompts must read /dev/tty, not script stdin.
    const child = spawn("script", ["-qefc", `/bin/cat ${quote(helper)} | /bin/sh`, "/dev/null"], { env: environment });
    let output = "";
    let selected = false;
    let confirmed = false;
    child.on("error", reject);
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (!selected && output.includes("Choose [1/2/q]:")) {
        selected = true;
        child.stdin.write(`${choice}\n`);
      }
      if (!confirmed && confirmation !== undefined && output.includes("Press Enter to reopen")) {
        confirmed = true;
        void (async () => {
          await beforeConfirmation?.();
          child.stdin.write(`${confirmation}\n`);
        })().catch(reject);
      }
    });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.on("close", code => resolve({ code, output }));
    t.after(() => { if (child.exitCode === null) child.kill(); });
  });
  return {
    home, root, profile, dedicated, helper, environment, run,
    ini: (content: string) => writeFile(path.join(root, "profiles.ini"), content),
    processes: (content: string) => writeFile(path.join(home, "processes"), content),
    listen: () => writeFile(path.join(home, "listening"), ""),
    async noSideEffects() {
      for (const name of ["ssh.args", "launch.args"]) await assert.rejects(stat(path.join(home, name)), { code: "ENOENT" });
    },
  };
}

test("publisher requires an interactive choice and supports cancellation without side effects", options, async t => {
  const f = await fixture(t);
  for (const choice of ["q", ""]) {
    const result = await f.run(choice);
    assert.equal(result.code, 0, result.output);
    await f.noSideEffects();
  }
  const invalid = await f.run("3");
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /Choose 1, 2, or q/);
  const noTerminal = await new Promise<string>((resolve, reject) => {
    const child = spawn("sh", [f.helper], { env: f.environment, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.on("error", reject);
    child.on("close", code => { assert.notEqual(code, 0); resolve(output); });
  });
  assert.match(noTerminal, /real desktop terminal/);
  await f.noSideEffects();
});

test("default resolution matches Pi: install precedence, fallback, absolute paths and whitespace", options, async t => {
  const f = await fixture(t);
  const absolute = path.join(f.home, "profile with spaces [x]");
  await mkdir(absolute);
  for (const ini of [
    "[InstallA]\nDefault=normal.default\n[Profile0]\nDefault=1\nPath=unused\n",
    "[Profile0]\nDefault=1\nIsRelative=1\nPath=normal.default\n",
    `[Profile0]\r\nIsRelative=0\r\nPath=${absolute}\r\nDefault=1\r\n`,
    ` [InstallA] \r\n Default = ${absolute} \r\n`,
  ]) {
    await f.ini(ini);
    const expected = await firefoxDefaultProfile(f.home);
    const result = await f.run("1", "q");
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes(`Default profile: ${expected}`), result.output);
    await f.noSideEffects();
  }
});

test("default resolution refuses missing, ambiguous or absent profiles without creating them", options, async t => {
  const f = await fixture(t);
  for (const ini of [
    "[InstallA]\nDefault=normal.default\n[InstallB]\nDefault=other\n",
    "[Profile0]\nDefault=1\nPath=a\n[Profile1]\nDefault=1\nPath=b\n",
    "[Profile0]\nPath=normal.default\n",
    "[InstallA]\nDefault=does-not-exist\n",
  ]) {
    await f.ini(ini);
    const result = await f.run("1");
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /ambiguous|does not exist/);
    await f.noSideEffects();
  }
  await rm(path.join(f.root, "profiles.ini"));
  const missing = await f.run("1");
  assert.equal(missing.code, 1);
  assert.match(missing.output, /No Firefox profiles.ini/);
  await assert.rejects(stat(path.join(f.root, "does-not-exist")), { code: "ENOENT" });
});

test("macOS resolves the ordinary Application Support profile with spaces", options, async t => {
  const f = await fixture(t, "Darwin");
  const result = await f.run("1", "q");
  assert.equal(result.code, 0, result.output);
  assert.ok(result.output.includes(`Default profile: ${f.profile}`), result.output);
  await f.noSideEffects();
});

test("normal Firefox must be quit by the human before default-profile startup", options, async t => {
  const f = await fixture(t);
  const originalMode = (await stat(f.profile)).mode & 0o777;
  for (const process of [
    "/usr/bin/firefox\n", "/usr/bin/firefox -P default\n",
    `/usr/bin/firefox --profile ${f.profile}\n`, `/usr/bin/firefox -profile ${f.profile}\n`,
  ]) {
    await f.processes(process);
    const result = await f.run("1", "");
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Fully quit it and rerun; no browser was stopped/);
    await f.noSideEffects();
  }
  const result = await f.run("1", "", () => f.processes(""));
  assert.equal(result.code, 0, result.output);
  const args = JSON.parse(await readFile(path.join(f.home, "launch.args"), "utf8")) as string[];
  assert.deepEqual(args, ["--new-instance", "--profile", f.profile, "--remote-debugging-port", "9222", "--remote-allow-hosts", "localhost,127.0.0.1"]);
  assert.match(await readFile(path.join(f.home, "ssh.args"), "utf8"), /\/receiver\/browser-sockets\/publisher.sock:127.0.0.1:9222\nclaude@voidpc/);
  assert.equal((await stat(f.profile)).mode & 0o777, originalMode, "does not chmod the existing user profile");
});

test("dedicated option is persistent, independent of default config, and can coexist with normal Firefox", options, async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, "profiles.ini"));
  await f.processes("/usr/bin/firefox\n");
  const result = await f.run("2");
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes("Press Enter to reopen"));
  const args = JSON.parse(await readFile(path.join(f.home, "launch.args"), "utf8")) as string[];
  assert.equal(args[2], f.dedicated);
  assert.equal((await stat(f.dedicated)).mode & 0o777, 0o700);
});

test("both choices reuse only the verified selected profile and port, without restart", options, async t => {
  const f = await fixture(t);
  await f.listen();
  for (const [choice, profile] of [["1", f.profile], ["2", f.dedicated]]) {
    await f.processes(`/usr/bin/firefox --profile=${profile} --remote-debugging-port=9222\n`);
    const result = await f.run(choice!);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Reusing Firefox profile/);
    assert.ok(!result.output.includes("Press Enter to reopen"));
    await assert.rejects(stat(path.join(f.home, "launch.args")), { code: "ENOENT" });
  }
});

test("occupied unverified listeners and dedicated busy profiles are refused", options, async t => {
  const f = await fixture(t);
  await f.listen();
  for (const process of [
    "", "/usr/bin/firefox --remote-debugging-port=9222\n",
    `/usr/bin/firefox --profile ${f.profile}-other --remote-debugging-port 9222\n`,
    `/usr/bin/firefox --profile ${f.profile} --remote-debugging-port 9223\n`,
    `/usr/bin/firefox --profile ${f.dedicated} --remote-debugging-port 9222\n`,
  ]) {
    await f.processes(process);
    const result = await f.run("1");
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Port 9222 is occupied/);
    await f.noSideEffects();
  }
  await rm(path.join(f.home, "listening"));
  await f.processes(`/usr/bin/firefox --profile ${f.dedicated}\n`);
  const result = await f.run("2");
  assert.equal(result.code, 1);
  assert.match(result.output, /no second browser was started/);
  await f.noSideEffects();
});
