# pi-browser

Shared Chromium/CDP and Firefox/WebDriver BiDi infrastructure, plus `browser`,
`web_search`, `web_fetch`, and `web_read` tools for Pi. `pagent` imports the same
package as an SDK dependency and exposes the three web tools, not `browser`.
Its `pagent [directory]` CLI opens the directory's `index.html` in one controlled
page, preferring installed Firefox, otherwise Chromium. Neither depends on `pi-ant`.

Requires Node 24+ and a recent Chromium or Firefox for browser operations.
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
→ `auto`. Reset is not Auto: with `PI_WEB_BACKEND=browser`, Reset selects browser.
Each web invocation snapshots its policy before any asynchronous work. Switching
affects subsequent calls; it does not reroute/cancel an active or queued request,
close tabs, or discard cookies/challenge state. To switch a request waiting for a
CAPTCHA, cancel that request, change the policy, then retry.

### Browser engine default

`/browser-default` chooses the engine independently of `/web-backend`:

```text
/browser-default             # Picker: configured default, Chromium, Firefox
/browser-default firefox
/browser-default chromium
/browser-default reset       # Follow the configured engine, not always Chromium
/browser-default status
```

This is a session-branch override with the same reload/resume, fork, tree, and
New behavior as `/web-backend`. The footer shows `browser:<engine>` with `*` for
an override. It does not change global settings, the environment, or web backend
policy. Non-UI invocation without arguments reports status instead of prompting.

Search/fetch snapshot the engine when invoked, even before Codex authentication
or browser queuing. Codex results are unaffected; browser execution and fallback
use that snapshot. Each engine lazily owns its own research process, cookies,
queue, and pending pages. Switching does not launch or close a browser. Switching
back reuses the original research state; retrying while a different engine is
selected starts work there rather than resuming the other engine's pending page.

For `browser`, a new named session uses its explicit `browser` argument or the
selected default. Existing named sessions always keep their engine, including
recovery after process loss; a conflicting explicit argument remains an error.
Close the session with `/browser-close <name>` or use a new name to change engines.
Active and already-queued invocations are not rerouted by a default change.

The SDK web-tool set exposes `getBrowserState()` and
`setBrowserOverride("firefox" | "chromium" | null)`. Its `browserDefault` option
accepts a shared `createBrowserDefault({ browser? })` controller, exported from
`pi-browser/web`, for hosts coordinating multiple consumers. State reports
`configured`, `override`, `effective`, and `source`, just like backend state.
Pagent's workspace engine and UI are unchanged by this Pi command.

`PI_BROWSER_EXECUTABLE` (or the SDK `executable` option) is scoped to the
configured engine, not applied to a different engine after switching. Other
engines use their normal discovery, including `FIREFOX_BINARY` and
`CHROMIUM_BINARY`. There is no silent engine or headless fallback.

Environment defaults below are read when a web-tool set is created. Restart the
host or use Pi `/reload` after changing its process environment.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PI_WEB_BACKEND` | `auto` | `auto`, `codex`, or `browser` |
| `PI_WEB_BROWSER` | `chromium` | `chromium` or `firefox` |
| `PI_WEB_SEARCH_ENGINE` | `duckduckgo` | `duckduckgo`, `bing`, or `brave` |
| `PI_BROWSER_HEADLESS` | `false` | Explicit `true`/`1` or `false`/`0` |
| `PI_BROWSER_EXECUTABLE` | engine discovery | Browser executable override |
| `PI_WEB_PROFILE_DIR` | host-specific | Dedicated research profile root; engine subdirectories are added |

`auto` attempts Codex first for each call. Missing/expired credentials, unavailable
or unsupported service/model, transport errors/timeouts, HTTP 429, and service
5xx responses fall back to the browser. The tool reports the fallback reason and
backend used. Cancellation, invalid arguments, malformed responses, and ordinary
request errors do **not** trigger fallback. `codex` never falls back; `browser`
never reads Codex credentials. There is no curl/HTTP-scraping fallback.

```sh
# Default: Codex first, browser when unavailable.
pi

# Always use a visible Firefox for research.
PI_WEB_BACKEND=browser PI_WEB_BROWSER=firefox pi

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
  plus a snapshot ID. Default **10**, maximum **20** results; preview capped at
  **200 lines / 16 KiB**. Search adapters exclude known ads, unwrap known tracking
  links, deduplicate results, and distinguish confirmed empty searches from
  loading, challenges, and unsupported layouts. Excerpts are not fetched pages.
  Codex counts come from actual structured results; unknown formats remain raw
  with a warning and unknown count rather than pretending to enforce the limit.
- `web_fetch({url})`: readable Markdown plus a snapshot ID, preview capped at
  **2000 lines / 50 KiB**. There is no format or mode argument. URLs must be
  HTTP(S) without embedded credentials. Cite the fetched URL.
- `browser({session_id?, browser?, url?, eval?})`: named persistent tab, optional
  navigation, pre-eval screenshot, awaited JavaScript expression, then final
  capture. Returns a compact **8 KiB** receipt and small eval results/errors;
  eval previews are capped at **4 KiB / 60 lines**, with larger captured results
  in snapshot JSON. Omit `url` to preserve user changes; existing named sessions
  keep their engine. Use async IIFEs for multiple statements in either engine.
  `/browser-close [session_id]` closes a named browser (default `default`).
  Ordinary eval errors retain the session; screenshot failures do not discard
  completed eval/content. Inspect saved HTML first, screenshots for visual evidence.
- `web_read({snapshot, format?, cursor?})`: read immutable saved evidence without
  network, credentials, or changes to a live page. Default format is `md`; other
  formats are `text`, `html`, `json`, `screenshot`, and `before-screenshot`.
  Only `before-screenshot` captures pre-eval state, after optional navigation;
  there is no phase selector or other before format. Missing or expired evidence
  reports unavailable, never triggers a live recapture or backend fallback.

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
manual browser and search/fetch producers. Reload/resume retain evidence; normal
forks copy it within bounds, preserving IDs/cursors but not profiles. New sessions
start empty. Manual profiles use adjacent `manual/`; research profiles use
`research/`. Profiles preserve cookies on normal close and are not shared with
the user's ordinary browser profile.

Pagent uses private `<directory>/.pagent/web-snapshots/<sha256(agentId)>/`
stores, retained across restart and same-ID agent recreation. These stores are
never HTTP-served, and Pagent exposes no host filesystem tools. Its starter UI
renders native tool images. Installed CLI updates do not replace the directory's
editable HTML or UI modules.

Web retrieval owns a **separate research process per used engine**, never the
Pagent workspace browser or the manual browser-tool process. Each engine retains
up to three completed pages and at most eight total research tabs. Unfinished intervention pages are
never automatically evicted. Independent Pi sessions have independent profiles.
Explicit profile overrides are exclusive: concurrent owners get a clear error.
Anonymous SDK clients without a supplied profile path receive unique paths.

## Human intervention and cancellation

A CAPTCHA, login, consent dialog, or unreadable page pauses extraction. The host
focuses the research tab and asks for intervention. Complete the check or correct
the page yourself, then Continue. Continuation inspects **the same tab without
reloading or repeating navigation**. Each wait has a fresh continuation ID.

Pi uses its confirmation UI, including RPC-capable hosts. Pagent provides native
Continue/Cancel controls in its own UI. Hosts without an attention callback get
an actionable error with URL/tab ID; retrying the identical operation resumes
that page. Challenges are never solved automatically. Detection is heuristic,
not a promise that every access check can be recognized or completed.

Cancelling while waiting for a human leaves the page intact while its host stays
alive. Cancelling or timing out **running JavaScript** closes the affected
Chromium research tab; Firefox must stop its research process. A later call
reports the loss and opens a fresh tab/process. It does not silently rerun the
failed operation. Pagent's UI process and unsaved workspace DOM are unaffected.
Closing/reloading the Pi extension or shutting down Pagent closes its owned
research browsers; cookies survive normal shutdown but unsaved pages do not.

Extraction includes only accessible content, not closed shadow roots,
cross-origin embedded documents, PDF viewer text, or canvas pixels. It has
explicit traversal/output bounds and reports omissions. SPA readiness and
article selection are heuristic; inspect complex pages with the browser when
needed. Page contents are untrusted data, not instructions. No provider secrets
or Pagent `aos` bridge are installed in research pages.

## Library boundary

```ts
import { launchBrowser } from 'pi-browser';
import { createWebTools, SnapshotStore } from 'pi-browser/web';

const web = createWebTools({
  profileDir: '/private/application-state/research',
  snapshots: new SnapshotStore({ directory: '/private/application-state/snapshots' }),
  onAttention: async (request, signal) => hostConfirm(request, signal),
  onProgress: message => hostLog(message),
});
// Pass web.tools to Pi SDK customTools. Runtime control is host-side:
web.setBackendOverride('browser');
web.getBackendState(); // { configured, override, effective, source }
web.setBackendOverride(null); // Reset to the original configuration.
// Call web.close() on host shutdown; switching policy never requires close().
```

The root entry point contains no Pi imports. It exports typed browser sessions,
tabs, the reusable `BrowserProcessLauncher`, and `findBrowserExecutable(kind)`.
Executable discovery is shared with startup; Pagent uses it to prefer installed
Firefox without duplicating platform-specific paths. `pi-browser/cdp` and
`pi-browser/bidi` expose low-level transports for application adapters. The
`pi-browser/web` entry point adds Pi-compatible tool definitions and host auth.
`pi-browser/extension` registers all four tools in Pi. `createWebTools()` returns
search, fetch, and read definitions sharing its `snapshots` store. Supply a private
store directory for durable SDK evidence; the default is a unique temporary path.

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
node --test --test-concurrency=1 test/backend-command.test.ts test/web-backend.test.ts
node --test --test-concurrency=1 test/browser-default-command.test.ts test/browser-default.test.ts

# Optional: visible, sandboxed Firefox/Chromium windows on the live host display.
# Local HTTP fixtures only; no model or public-network requests.
PI_BROWSER_LIVE_DISPLAY=1 node --test test/headed-browser.test.ts
```

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

A profile's `.pi-browser-owner/owner.json` records the owner and browser PIDs.
Never remove its lock or terminate a browser solely because a previous command
failed. Confirm both recorded processes have stopped first. Then remove only
that profile's `.pi-browser-owner` directory and retry. Debugging sockets bind
to loopback; keep them and profiles private. This is local trusted-user
software, not a multi-tenant security boundary.
