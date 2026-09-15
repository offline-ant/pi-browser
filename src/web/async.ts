/** Bound host-side waiting without putting a long-running Promise into an external page. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function validateWebUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); }
  catch { throw new Error("Invalid URL: provide an absolute HTTP or HTTPS URL."); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid URL: protocol must be HTTP or HTTPS.");
  if (parsed.username || parsed.password) throw new Error("Invalid URL: embedded credentials are not permitted.");
  return parsed.href;
}
