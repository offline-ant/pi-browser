import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { TabClosed, type BrowserClient } from "../src/broker/client.ts";
import { processAlive } from "../src/broker/protocol.ts";
import type { OperationOptions } from "../src/core/types.ts";

/** Brokers live under os.tmpdir(); a fresh TMPDIR isolates them. Leftover brokers (and their browsers) are stopped afterwards. */
export async function isolateBrokers(t: TestContext): Promise<string> {
  const previous = process.env.TMPDIR;
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-test-"));
  process.env.TMPDIR = root;
  t.after(async () => {
    await stopBrokers(root);
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

export function brokerDirectory(root: string): string {
  return path.join(root, `pi-browser-${process.getuid!()}`);
}

/** Broker pids from their records in an isolated TMPDIR. */
export async function brokerPids(root: string): Promise<number[]> {
  let names: string[];
  try { names = await readdir(brokerDirectory(root)); } catch { return []; }
  const pids: number[] = [];
  for (const name of names.filter(name => name.endsWith(".json"))) {
    try { pids.push(JSON.parse(await readFile(path.join(brokerDirectory(root), name), "utf8")).pid); } catch { /* Removed meanwhile. */ }
  }
  return pids;
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, message = "condition"): Promise<void> {
  for (const started = Date.now(); !(await condition()); await delay(25)) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${message}`);
  }
}

export async function stopBrokers(root: string): Promise<void> {
  const pids = await brokerPids(root);
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* Already gone. */ } }
  try { await waitFor(() => pids.every(pid => !processAlive(pid)), 10_000, "brokers to exit"); }
  catch { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } } }
}

export async function fixtureServer(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

/** Ordinary local pages: the title is the request path. */
export function htmlPage(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end(`<!doctype html><title>${request.url}</title><main>Fixture ${request.url}</main>`);
}

/** The part of a shared tab that web research uses. */
export interface ResearchTab {
  readonly name: string;
  readonly closed: boolean;
  navigate(url: string, options?: OperationOptions): Promise<void>;
  evaluate(expression: string, options?: OperationOptions): Promise<unknown>;
  screenshot(): Promise<string>;
  focus(): Promise<void>;
}

/** A broker client stand-in for research unit tests: open({create}) yields fixture tabs, open({id}) holds an issued one again. */
export function fixtureClient(open: () => ResearchTab | Promise<ResearchTab>, headless = false): BrowserClient {
  const issued = new Map<string, ResearchTab>();
  const hold = (tab: ResearchTab, id: string) => ({
    id, name: tab.name, get closed() { return tab.closed; },
    navigate: (url: string, options?: OperationOptions) => tab.navigate(url, options),
    evaluate: (expression: string, options?: OperationOptions) => tab.evaluate(expression, options),
    screenshot: () => tab.screenshot(), focus: () => tab.focus(), release: async () => {},
  });
  return {
    headless, source: { browser: "chromium", profileDir: "/nonexistent", headless },
    async open(params: { id?: string }, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (params.id !== undefined) {
        const tab = issued.get(params.id);
        if (!tab || tab.closed) throw new TabClosed("The tab was closed.");
        return { tab: hold(tab, params.id), browser: "chromium", created: false, warnings: [] };
      }
      const tab = await open();
      const id = String(issued.size);
      issued.set(id, tab);
      return { tab: hold(tab, id), browser: "chromium", created: true, warnings: [] };
    },
  } as unknown as BrowserClient;
}
