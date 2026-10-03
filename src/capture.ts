import type { BrowserTab, OperationOptions } from "./core/types.ts";
import { captureExpression } from "./web/extract.ts";

export interface PageCapture {
  html: string;
  md: string;
  text: string;
  json: Record<string, unknown>;
  warnings: string[];
  capturedAt: string;
}

export interface PageCaptureOptions extends OperationOptions {
  kind?: "search" | "fetch";
  engine?: "duckduckgo" | "bing" | "brave";
}

/** All text artifacts and json inspection fields share one synchronous observation. Screenshots are producer-owned. */
export async function capturePage(tab: Pick<BrowserTab, "evaluate">, options: PageCaptureOptions = {}): Promise<PageCapture> {
  const { kind = "fetch", engine = "duckduckgo", ...operation } = options;
  const value = await tab.evaluate(captureExpression(kind, engine), operation);
  if (!value || typeof value !== "object") throw new Error("Page capture returned no structured observation.");
  const captured = value as Partial<PageCapture>;
  if (typeof captured.html !== "string" || typeof captured.md !== "string" || typeof captured.text !== "string" ||
    typeof captured.capturedAt !== "string" || !captured.json || typeof captured.json !== "object" ||
    !Array.isArray(captured.warnings) || captured.warnings.some(warning => typeof warning !== "string")) {
    throw new Error("Page capture returned an invalid observation.");
  }
  return captured as PageCapture;
}
