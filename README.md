# pi-browser

Shared Chromium/CDP and Firefox/WebDriver BiDi infrastructure, plus `browser`,
`web_search`, `web_fetch`, and `web_read` tools for Pi. `pagent` imports the same
package as an SDK dependency and exposes the three web tools, not `browser`.
Its `pagent [directory]` CLI opens the directory's `index.html` in one controlled
page, preferring installed Firefox, otherwise Chromium. Neither depends on `pi-ant`.

Requires Node 24+ and a recent Chromium or Firefox on the browser host.
Codex operations need Pi's `openai-codex` OAuth credentials, independently of the
inference provider. Browser operations need no model-provider credentials.

## Backend settings

Backend policy is host/session configuration, **not a model tool argument**.
Use `/web-backend` in Pi to open a picker, or set it directly:

```text
/web-backend browser    # Browser only; bypass Codex
/web-backend codex      # Codex only; no fallback
/web-backend auto       # Codex first, browser fallback
/web-backend reset      # Follow configured default again
/web-backend status     # Show policy and its source without opening the picker
```

The command applies to search/fetch and overrides `PI_WEB_BACKEND` for the
current session branch. It survives `/reload` and `/resume`; normal Pi forks
inherit the setting at the fork point. Tree navigation restores the selected
branch's setting. Independent new sessions follow their configured defaults.
The footer shows `web:<policy>` with `*` for a session override. No global settings
or environment variables are modified. Pagent has an equivalent Web backend
dropdown with private per-workspace persistence.

Precedence is runtime override → explicit SDK host setting → `PI_WEB_BACKEND`
→ `browser`. Reset is not a fixed policy: with `PI_WEB_BACKEND=auto`, Reset selects Auto.
Each web invocation snapshots its policy before any asynchronous work. Switching
affects subsequent calls; it does not reroute/cancel an active or queued request,
close tabs, or discard cookies/challenge state. To switch a request waiting for a
CAPTCHA, cancel that request, change the policy, then retry.

### Browser selection

One browser serves `browser`, `web_search`, and `web_fetch`. Choose it with
`/browser` (picker when omitted) or `PI_BROWSER`:

```text
/browser                          # Picker: configured, Chromium, Firefox, default profile, remotes
/browser chromium                 # Stable Pi profile <agentDir>/browser/profiles/chromium
/browser firefox                  # Stable Pi profile <agentDir>/browser/profiles/firefox
/browser firefox-default-profile  # This OS user's own Firefox default profile
/browser remote void-flip         # A published remote browser (see below)
/browser reset                    # Follow PI_BROWSER (default chromium)
/browser status
```

`PI_BROWSER` accepts `chromium`, `firefox`, `firefox-default-profile`, or
`remote:<name>`. The command is a session-branch override with the same
reload/resume, fork, tree, and New behavior as `/web-backend`; the footer shows
`browser:<choice>` with `*` for an override. Switching affects later calls only;
open tabs, cookies, and running calls are unchanged, and the previous browser
keeps this session's connection until the session ends.

Pi profiles are stable across sessions: history, cookies, and logins persist.
`firefox-default-profile` resolves `~/.mozilla/firefox/profiles.ini`: the single
`[Install…]` `Default=`, otherwise the single profile with `Default=1`; anything
else is an ambiguity error. Firefox refuses to start on a profile that another
Firefox already uses; close it first. **Pages logged in there are visible to the
agent**, including through search/fetch, which run in the same browser.

`FIREFOX_BINARY` and `CHROMIUM_BINARY` override executable discovery. There is
no silent engine or headless fallback.

### Shared browser broker

Every browser source (a profile or a published remote socket) has one **broker**:
a small detached Node process that is the only holder of the browser's debugging
connection. Firefox accepts just one WebDriver BiDi session, so this is what lets
any number of Pi sessions, workers, and forks share one browser window. The first
call starts the broker; it launches the profile's browser (or attaches to the
remote) and holds the profile's exclusive lock. Later sessions connect to its
private Unix socket in `$TMPDIR/pi-browser-<uid>/` (mode `0700`, owner-checked),
keyed by the profile's real path or the remote socket path. The broker exits
**60 seconds** after its last session disconnects: a launched browser is closed
normally (cookies flushed); a remote keeps running with only Pi-opened tabs closed.

Launch settings are fixed by the session that started the broker; a session
asking for a different headless mode gets an error rather than a second browser.
If a socket refuses connections and its recorded broker has exited, or a
profile lock's recorded broker and browser processes have exited, the next
session takes over automatically; a live owner is an error, never killed.
The broker log is `$TMPDIR/pi-browser-<uid>/<key>.log`.

**Every tab has a name.** Automatic names are the host (with port) without a
leading `www.`, plus `+` and the length of everything after `host/`:
`https://www.google.com/search` → `google.com+6`, `https://google.com/` →
`google.com`, `about:blank` → `about+5`. Duplicates get `-2`, `-3`. A name is
fixed when the tab is first seen. Tabs opened by people or pages are discovered,
named, listed, and usable, but **never closed automatically**.

The broker keeps each connected session's **10 most recently used tabs**; the most
recent is that session's default tab. At every request and disconnect it closes
Pi-opened tabs that are in no connected session's list. There is no ownership:
any session can list and use any tab. Using a tab another session used since your
last use returns a warning. Each `browser`, `web_search`, or `web_fetch` call holds
its tab exclusively from resolving it to its final capture (research releases it
while waiting for human intervention), so calls on one tab,
from any session, run one after another; a cancelled waiting call releases nothing,
and a disconnecting session releases its tabs. Different tabs run in parallel. Interrupting running JavaScript closes that tab in either engine
(Chromium stops the script first); if closure fails, a launched browser is stopped
and restarted by the next call, or a remote connection is dropped, and every
session is told its tabs are gone. A launched browser keeps its first blank tab
as an unlisted window anchor, so closing a Pi tab never closes the window.

Environment defaults below are read when a Pi session first uses the tools. Restart the
host or use Pi `/reload` after changing its process environment.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PI_WEB_BACKEND` | `browser` | `auto`, `codex`, or `browser` |
| `PI_BROWSER` | `chromium` | `chromium`, `firefox`, `firefox-default-profile`, or `remote:<name>` |
| `PI_WEB_SEARCH_ENGINE` | `duckduckgo` | `duckduckgo`, `bing`, or `brave` |
| `PI_BROWSER_HEADLESS` | `false` | Explicit `true`/`1` or `false`/`0` |

`auto` attempts Codex first for each call. Missing/expired credentials, unavailable
or unsupported service/model, transport errors/timeouts, HTTP 429, and service
5xx responses fall back to the browser. The tool reports the fallback reason and
backend used. Cancellation, invalid arguments, malformed responses, and ordinary
request errors do **not** trigger fallback. `codex` never falls back; `browser`
never reads Codex credentials. There is no curl/HTTP-scraping fallback.

```sh
# Default: research in the browser selected for the `browser` tool.
pi

# Codex first, browser when unavailable.
PI_WEB_BACKEND=auto pi

# Always use a visible Firefox for research.
PI_BROWSER=firefox pi

# Strict Codex-only: errors remain errors.
PI_WEB_BACKEND=codex pi
```

Headed mode is the default. A missing graphical display produces an actionable
error rather than silently launching an invisible browser. Explicit headless mode
is intended for unattended use and tests; it cannot offer manual clicking.
Sandboxes remain enabled. The low-level API permits an explicit Chromium-only
`noSandbox` opt-out; normal tools do not expose it.

On Linux, local X11 probing includes both abstract and filesystem sockets. A
permission-denied Wayland or filesystem socket does not rule out a working
abstract X11 connection. The launcher pins the reachable display backend for
both engines, without changing permissions or X11 authorization. Headed Chromium
starts with a 1280×900 window so fresh profiles cannot default to an empty content
viewport and hang screenshot capture; headless geometry is unchanged.

## Tool behavior

- `web_search({query, max_results?})`: compact numbered titles, links, and excerpts,
  plus a snapshot ID. Browser results open in an automatically named tab of the
  shared browser and report its name, usable with `browser`. Default **10**, maximum **20** results; preview capped at
  **200 lines / 16 KiB**. Search adapters exclude known ads, unwrap known tracking
  links, deduplicate results, and distinguish confirmed empty searches from
  loading, challenges, and unsupported layouts. Excerpts are not fetched pages.
  Codex counts come from actual structured results; unknown formats remain raw
  with a warning and unknown count rather than pretending to enforce the limit.
- `web_fetch({url})`: readable Markdown plus a snapshot ID (and its tab name with
  the browser backend), preview capped at
  **2000 lines / 50 KiB**. There is no format or mode argument. URLs must be
  HTTP(S) without embedded credentials. Cite the fetched URL.
- `browser({tab?, url?, eval?, list?})`: use a named tab of the selected shared
  browser: optional navigation, pre-eval screenshot, awaited JavaScript expression,
  then final capture. Omitted `tab` uses this session's last tab; an unknown `tab`
  with `url` opens a new tab with that name; an unknown `tab` without `url` is an
  error. Without a usable last tab, `url` opens an automatically named tab and
  says so when the previous one vanished; without `url` it is an error. Omit `url`
  to preserve the page. `list: true` lists all tabs with title, URL, last-using
  session and time, and marks this session's default. Returns a compact **8 KiB**
  receipt with tab name and full URL plus small eval results/errors; eval previews
  are capped at **4 KiB / 60 lines**, with larger captured results in snapshot
  JSON. Use async IIFEs for multiple statements in either engine. Ordinary eval
  errors retain the tab; screenshot failures do not discard completed eval/content.
  Inspect saved HTML first, screenshots for visual evidence. Concurrent calls on the
  same tab wait for each other; use separate tabs for parallel work.
- `web_read({snapshot, format?, cursor?})`: read immutable saved evidence without
  network, credentials, or changes to a live page. Default format is `md`; other
  formats are `text`, `html`, `json`, `screenshot`, and `before-screenshot`.
  Only `before-screenshot` captures pre-eval state, after optional navigation;
  there is no phase selector or other before format. Missing or expired evidence
  reports unavailable, never triggers a live recapture or backend fallback.

### Published remote browsers

Selecting a remote (`/browser remote <name>` or `PI_BROWSER=remote:<name>`)
makes `browser`, `web_search`, and `web_fetch` share that browser through its
broker. Pagent's workspace browser is unaffected. The publisher runs a dedicated desktop browser with debugging on
**127.0.0.1:9222**, then SSHes **into the Pi host**, forwarding a private Unix
socket to that debugging port. Pi never initiates SSH or launches a remote browser.
This also works when Pi runs in a VM that cannot SSH outward.

In Pi, request setup instructions (the helper always publishes Firefox):

```text
/browser-remote-setup
# Optional address override, reachable from the publisher:
/browser-remote-setup user@pi-host
```

The SSH target defaults to the Pi process's `username@hostname`. Supply an SSH
alias or IP if that hostname is not reachable **from the publisher**. Overrides
without `user@` retain the Pi username so SSH reaches the receiving account.
No prompts or remote-name argument are needed. Setup prints discovered socket
names; the helper derives its publisher name with `hostname` (for example,
`void-flip`). There is no registry or persistent remote selector.

Setup lazily creates `getAgentDir()/browser-sockets/` with mode `0700` and installs
the packaged shell helper at `getAgentDir()/browser-open`. The receiver's absolute
socket directory and chosen SSH target are embedded. Rerunning setup reinstalls
these defaults. It prints one fetch-and-run command with the actual path:

```sh
# Run ON the publisher in a real desktop terminal; keep this tunnel open.
ssh user@pi-host 'cat /home/pi/.pi/agent/browser-open' | sh
```

The helper accepts just one optional argument, an SSH target override:
`| sh -s -- user@other-address`. This changes only the tunnel destination, not the
embedded receiving socket directory. No IP enumeration or network scan is needed.

The publisher needs Firefox, `curl`, `ssh`, and standard `ps`/`awk`. The helper
uses **one fixed persistent profile**, `$HOME/.local/share/pi-browser/firefox-9222`.
If port `127.0.0.1:9222` responds, it checks this user's Firefox process arguments
for that exact profile and debugging port before reusing it. An ordinary browser,
another profile, or an unverified listener is refused; an HTTP response alone is
not enough. An already-running dedicated instance is left untouched. This is an
incidental-mismatch check, not protection against malicious same-user processes.

If no listener exists and that profile is not already running, the helper discovers
and starts Firefox on Darwin/Linux as the desktop user, inheriting the
display/Wayland environment. A busy profile without an available debugging port
is an error; it never removes profile locks or restarts a browser. It never uses
the default browser profile, sudo, headless mode, or disabled sandboxing. A failed
startup reports the profile's `browser.log`. A Chromium published the same way
(debugging on 127.0.0.1:9222, socket forwarded into the same directory) also
works: the broker detects Chromium by its `/json/version` browser WebSocket URL and
otherwise uses Firefox WebDriver BiDi. This helper launches only Firefox.

The helper then runs the inbound SSH tunnel in the foreground. Ctrl+C closes the
tunnel, **not the browser**; the publisher owns that browser. No automatic socket
unlink or browser shutdown is performed.

Select it by name:

```text
/browser remote void-flip
```

Or start Pi with it as the configured browser:

```sh
PI_BROWSER=remote:void-flip pi
```

Remote names contain 1–64 letters, digits, dots, underscores or hyphens, starting with a
letter or digit. Only actual `.sock` Unix sockets are accepted, never symlinks.
Model receipts refer to names, not socket paths. The tools have no browser,
remote, `ssh`, or `endpoint` arguments; the user selects the browser.

A failed connection gives actionable instructions and, with TUI/RPC, asks for
**one** retry after restoring the publisher tunnel/browser. Decline, no UI, or a
failed final attempt returns an error. Abort never retries. Navigation and eval
are never repeated by this retry, and there is no automatic local fallback.
Search/fetch report the connection error without the retry prompt.

The remote's broker holds its single debugging connection (Firefox's **single
BiDi session**) for all Pi sessions; other automation clients must wait until the
broker exits. Tabs the publisher's user opened are listed and usable but never
closed automatically; Pi-opened tabs follow the recent-tab rule and are closed
when the broker exits. Neither the broker nor Pi stops the publisher's browser or
SSH tunnel. A lost connection is reported to every session; the next call
reconnects. Interrupted eval closes only its tab; if closure cannot be confirmed,
the broker disconnects and warns that **JavaScript may continue running**.

SSH can leave a stale socket after disconnecting. Confirm its previous tunnel
has stopped, then manually remove **only that socket on the Pi host** before
restarting the publisher command. Never unlink a live socket; neither Pi nor the
helper uses `StreamLocalBindUnlink` or automatic stale cleanup.

Debug access grants **browser-wide control**, not just access to Pi's tabs. Trust
the Pi host and everyone who can access the socket or debugging port. Keep the
socket directory private and port 9222 loopback-only; loopback is not protection
from other users on the publisher. A dedicated profile separates browser state,
not OS-user permissions.

### Saved evidence

Browser captures eagerly generate all available formats at capture time, not
lazily on read. Markdown, text, HTML, and structured inspection share one
synchronous composed-DOM observation; screenshots are separate eager captures
with their own timestamps, not an atomic DOM/image freeze. Open shadow roots and
slots are traversed without modifying the page. Readable extraction preserves
headings, code, links, tables, and lists. HTML is an **inert rendered/composed-DOM
representation**, not original HTTP source or a runnable archive: scripts, styles,
hidden content, live form values, and resource loads are omitted. Closed shadow
roots, embedded documents, PDF viewer text, and canvas pixels are not extracted.
Traversal and capture limits are reported as warnings.

Codex saves normalized content when its format is recognized, structured search
results, and the original response/provenance in JSON. Unknown formats remain
raw with warnings. Original responses may contain an opaque encrypted field,
retained within capture bounds; host credentials are never included. Codex has
no rendered HTML or screenshots, and requesting them does not switch backends.

The shared disk `SnapshotStore` defaults to **64 snapshots / 256 MiB per owner**,
evicting oldest captures as needed. Text/JSON formats are bounded to **4 MiB each**;
PNG images to **1 MiB**, **8192 pixels per side / 16 megapixels**. Extraction can
reach smaller bounds first. Oversized/invalid images are omitted with warnings.
Captures may contain sensitive page data. Closing browsers does not delete them,
but saved history can reference IDs later expired by retention.

Text reads reserve **44 KiB / 1900 lines** for content, keeping the complete
receipt within **50 KiB / 2000 lines**. Continue with `nextCursor` as `cursor`,
using the same snapshot ID and format. JSON reads are valid JSON envelopes with
`encoding: "json-text"`; concatenate their decoded `chunk` strings in order,
then parse the reassembled saved JSON. Screenshots return native image blocks,
never base64 text dumps. Model-facing receipts expose IDs, not host paths;
`SnapshotStore.info(id).paths` is for trusted host use only.

Pi shares `browser/<pi-session-id>/snapshots/` under its agent directory between
the browser tool and search/fetch. Reload/resume retain evidence; normal forks copy
it within bounds, preserving IDs/cursors. New sessions start empty. Browser
profiles are not per session: Pi's stable profiles live in
`<agentDir>/browser/profiles/{chromium,firefox}` and preserve cookies on normal
close; `firefox-default-profile` and remotes use their own profiles.

Pagent uses private `<directory>/.pagent/web-snapshots/<sha256(agentId)>/`
stores, retained across restart and same-ID agent recreation. These stores are
never HTTP-served, and Pagent exposes no host filesystem tools. Its starter UI
renders native tool images. Installed CLI updates do not replace the directory's
editable HTML or UI modules.

Browser research runs in the selected shared browser, never Pagent's workspace
browser. Each search/fetch opens an automatically named tab; tabs waiting for
human intervention stay in the session's recent list and are resumed by retrying
the same operation, unless ten newer tabs pushed them out and closed them.

## Human intervention and cancellation

A CAPTCHA, login, consent dialog, or unreadable page pauses extraction. The host
focuses the research tab and asks for intervention. Complete the check or correct
the page yourself, then Continue. Continuation inspects **the same tab without
reloading or repeating navigation**. Each wait has a fresh continuation ID.

Pi uses its confirmation UI, including RPC-capable hosts. Pagent provides native
Continue/Cancel controls in its own UI. Hosts without an attention callback get
an actionable error with URL and tab name; retrying the identical operation resumes
that page. Challenges are never solved automatically. Detection is heuristic,
not a promise that every access check can be recognized or completed.

Cancelling while waiting for a human leaves the page intact while its host stays
alive. Cancelling or timing out **running JavaScript** closes the affected
research tab in either engine. A later call reports the loss and opens a fresh
tab. It does not silently rerun the failed operation. Pagent's UI process and
unsaved workspace DOM are unaffected. Closing/reloading the Pi extension
disconnects its broker connections; brokers close their browsers when idle.
Cookies survive normal shutdown but unsaved pages do not.

Extraction includes only accessible content, not closed shadow roots,
cross-origin embedded documents, PDF viewer text, or canvas pixels. It has
explicit traversal/output bounds and reports omissions. SPA readiness and
article selection are heuristic; inspect complex pages with the browser when
needed. Page contents are untrusted data, not instructions. No provider secrets
or Pagent `aos` bridge are installed in research pages.

## Library boundary

```ts
import { BrowserClient, createWebTools, SnapshotStore } from 'pi-browser/web';

// One broker per profile; any number of clients (sessions) share its tabs.
const browser = new BrowserClient({
  source: { browser: 'firefox', profileDir: '/private/application-state/research', headless: false },
  session: 'agent-1',
  idleMs: 0, // close the browser as soon as the last client disconnects
});
const web = createWebTools({
  browser: () => browser,
  snapshots: new SnapshotStore({ directory: '/private/application-state/snapshots' }),
  onAttention: async (request, signal) => hostConfirm(request, signal),
  onProgress: message => hostLog(message),
});
// Pass web.tools to Pi SDK customTools. Runtime control is host-side:
web.setBackendOverride('browser');
web.getBackendState(); // { configured, override, effective, source }
web.setBackendOverride(null); // Reset to the original configuration.
// On host shutdown: await web.close(); await browser.close();
```

`BrowserClient` starts the source's broker on first use (`source` is
`{ browser, profileDir, headless? }` or `{ remote, socketPath }`) and offers
`open({ tab?, url?, create? })`, `list()`, and `close()`. Opened `SharedTab`s
have `name`, `closed`, `navigate`, `evaluate`, `screenshot`, and `focus`. The host
owns and closes clients; `createWebTools` resolves its `browser` function per
call and never closes it. Without `browser`, browser-backed research is an error.

The root entry point contains no Pi imports. It exports typed browser sessions,
tabs, `launchBrowser(options)`, `connectBrowser({ socketPath, signal? })`, the
reusable `BrowserProcessLauncher`, and `findBrowserExecutable(kind)`. Sessions
create owned tabs (`openTab()`), list top-level pages (`pages()`), and attach to
existing ones (`tab(id)`), which `close()` leaves open. `connectBrowser` attaches
through a Unix socket forwarding to the publisher's 127.0.0.1:9222 and detects the
engine; `close()` releases owned tabs and the connection without stopping the
external browser. Both engines keep the logical Host `127.0.0.1:9222` for
WebSocket handshakes. Low-level CDP/BiDi clients retain endpoint support for owned
launches and optionally dial a supplied `socketPath`.
Executable discovery is shared with startup; Pagent uses it to prefer installed
Firefox without duplicating platform-specific paths. `pi-browser/cdp` and
`pi-browser/bidi` expose low-level transports for application adapters. The
`pi-browser/web` entry point adds Pi-compatible tool definitions and host auth.
`pi-browser/extension` registers all four tools in Pi. `createWebTools()` returns
search, fetch, and read definitions sharing its `snapshots` store. Supply a private
store directory for durable SDK evidence; the default is a unique temporary path.

The extension's internal `createBrowserTool({ browser, snapshots?, onSetup? })`
factory in `src/browser-tool.ts` is **not exported by `pi-browser/web`**.
`onSetup(instructions, signal): Promise<boolean>` returns true to authorize the
single remote connection retry; Pi wires it to its confirmation UI. Without a
callback, failures return instructions immediately.

Pagent retains its own workspace-origin restrictions, `aos` binding, event
protocol, checkpointing, and recovery policy. It never loads the extension entry
point or discovers unrelated Pi extensions or directory-local settings. It reads
only global Pi model/thinking preferences for its inference defaults.

## Development and portable packaging

```sh
cd pi-browser
npm ci --ignore-scripts
npm run check
npm run compile
node --test --test-concurrency=1 test/core-process.test.ts test/core-research.test.ts
node --test --test-concurrency=1 test/web.test.ts test/web-browser.test.ts test/web-lifecycle.test.ts
node --test test/snapshot-store.test.ts test/snapshot-regression.test.ts test/web-read.test.ts
node --test --test-concurrency=1 test/capture.test.ts test/web-capture-expression.test.ts test/web-final-capture.test.ts
node --test test/web-extract-review.test.ts
node --test --test-concurrency=1 test/browser-tool.test.ts test/extension.test.ts
node --test test/browser-remote.test.ts
node --test --test-concurrency=1 test/backend-command.test.ts test/web-backend.test.ts
node --test --test-concurrency=1 test/browser-command.test.ts test/browser-selection.test.ts test/broker.test.ts

# Optional: visible, sandboxed Firefox/Chromium windows on the live host display.
# Local HTTP fixtures only; no model or public-network requests.
PI_BROWSER_LIVE_DISPLAY=1 node --test test/headed-browser.test.ts
```

Tests isolate brokers by setting `TMPDIR` to disposable directories and use
disposable profiles, never real ones. The whole suite also runs in parallel with
`node --test test/*.test.ts`. The focused remote test uses disposable headless
Firefox and Chromium publishers and a local Unix forward (no SSH or model requests). It requires port 9222 to be free and refuses
an occupied port rather than touching an existing browser.

The distributable contains compiled JavaScript and declarations in `dist/`;
Node does not strip TypeScript inside installed dependencies. Local Pi settings
load this package's compiled extension, so recompile after editing it.

Pagent uses a versioned tarball in its own `vendor/` directory and bundles the
installed runtime dependencies, including `pi-browser` and the Pi SDK, into its
compiled npm CLI artifact. Installing
that artifact with `npm install -g --ignore-scripts <artifact>` requires neither
source checkout. Its source checkout can run `npm ci --ignore-scripts` without a
sibling browser checkout. To refresh the portable dependency during development:

```sh
node pi-browser/scripts/package-pagent.mjs
```

That command checks/compiles the package, packs it without lifecycle scripts,
and updates Pagent's dependency and lockfile. It does not publish anything.
Check Pagent afterward with `cd pagent && npm run check`, then focused tests.
Run `npm run compile` there before `npm pack --ignore-scripts`: its bin points to
compiled `dist/main.js`, and its artifact includes host code, starter templates,
the vendor tarball, and the complete bundled runtime. `npm start` also runs compiled
code. No public fake-model mode is exposed by Pagent.
Tests use disposable local browser fixtures, mock Codex transport, and faux
inference; no paid provider calls or automated CAPTCHA bypasses. Run browser-heavy
files with `--test-concurrency=1` rather than launching both projects' browser
checks concurrently; oversubscription can stall Chromium screenshot capture.

## Snapshot and profile recovery

A snapshot store's `.operation-lock/owner.json` records `pid` and `createdAt`.
An active operation owns that lock. Interrupted locks require explicit host-side
recovery: confirm the recorded owner has stopped, then remove only that store's
`.operation-lock` directory. Never infer owner death from a failed call or lock
age. There is no automatic stale-lock deletion; model tools cannot recover it.

A locally launched profile's `.pi-browser-owner/owner.json` records the broker
and browser PIDs. The next broker removes it automatically only when both recorded
processes have exited; otherwise it reports the profile as in use and never
terminates the owner. Likewise a broker socket whose recorded broker has exited is
replaced automatically. To stop a broker deliberately, end its sessions (it exits
60 seconds later) or send it SIGTERM; it closes its browser normally. Debugging
sockets bind to loopback; keep them, broker sockets, and profiles private. This is
local trusted-user software, not a multi-tenant security boundary.
