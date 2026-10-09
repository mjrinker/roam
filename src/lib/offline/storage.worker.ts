/// <reference lib="webworker" />
/**
 * Saves files into the browser's private file storage (OPFS) off the main thread: streams a Box address straight to disk, so a
 * multi-gigabyte film never sits in memory, and picks up where it stopped (Range) after an interruption.
 */

const DIR = "roam-downloads";

type In =
  | { type: "download"; jobId: string; file: string; url: string; startAt: number; expected: number | null }
  | { type: "cancel"; jobId: string }
  | { type: "remove"; reqId: number; names: string[] }
  | { type: "sizes"; reqId: number; names: string[] };

/** A download that gets no data for this long is treated as dropped (a lost connection can leave a request hanging for minutes). */
const STALL_MS = 20_000;

const aborts = new Map<string, AbortController>();
const scope = self as unknown as DedicatedWorkerGlobalScope;

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

async function download(msg: Extract<In, { type: "download" }>) {
  const { jobId, file, url, expected } = msg;
  let startAt = msg.startAt;
  const abort = new AbortController();
  aborts.set(jobId, abort);
  let handle: FileSystemSyncAccessHandle | null = null;
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      abort.abort();
    }, STALL_MS);
  };
  try {
    touch();
    const fileHandle = await (await dir()).getFileHandle(file, { create: true });
    handle = await fileHandle.createSyncAccessHandle();
    const have = handle.getSize();
    if (startAt > have) startAt = have; // never leave a gap
    if (expected !== null && startAt >= expected) {
      scope.postMessage({ type: "done", jobId, bytes: startAt });
      return;
    }
    const res = await fetch(url, { headers: startAt > 0 ? { Range: `bytes=${startAt}-` } : undefined, signal: abort.signal });
    if (!res.ok || !res.body) {
      scope.postMessage({ type: "error", jobId, status: res.status, message: `The server answered ${res.status}` });
      return;
    }
    if (startAt > 0 && res.status !== 206) {
      // The server ignored the range and is sending the whole file again: start over.
      startAt = 0;
    }
    handle.truncate(startAt);
    let at = startAt;
    let lastReport = 0;
    let sinceFlush = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      touch();
      if (done) break;
      handle.write(value, { at });
      at += value.byteLength;
      sinceFlush += value.byteLength;
      if (sinceFlush >= 32 * 1024 * 1024) {
        handle.flush();
        sinceFlush = 0;
      }
      const now = Date.now();
      if (now - lastReport > 300) {
        lastReport = now;
        scope.postMessage({ type: "progress", jobId, bytes: at });
      }
    }
    handle.flush();
    if (expected !== null && at < expected) {
      scope.postMessage({ type: "error", jobId, status: 0, message: "The connection ended before the file was complete" });
      return;
    }
    scope.postMessage({ type: "done", jobId, bytes: at });
  } catch (err) {
    const aborted = abort.signal.aborted && !stalled;
    scope.postMessage({ type: "error", jobId, status: 0, aborted, message: stalled ? "The connection stalled" : aborted ? "Cancelled" : (err as Error).message || "The download stopped" });
  } finally {
    clearTimeout(watchdog);
    aborts.delete(jobId);
    try {
      handle?.close();
    } catch {
      // already closed
    }
  }
}

scope.onmessage = async (event: MessageEvent<In>) => {
  const msg = event.data;
  if (msg.type === "download") void download(msg);
  else if (msg.type === "cancel") aborts.get(msg.jobId)?.abort();
  else if (msg.type === "remove") {
    const d = await dir();
    for (const name of msg.names) await d.removeEntry(name).catch(() => undefined);
    scope.postMessage({ type: "removed", reqId: msg.reqId });
  } else if (msg.type === "sizes") {
    const d = await dir();
    const sizes: Record<string, number> = {};
    for (const name of msg.names) {
      try {
        sizes[name] = (await (await d.getFileHandle(name)).getFile()).size;
      } catch {
        sizes[name] = 0;
      }
    }
    scope.postMessage({ type: "sizes", reqId: msg.reqId, sizes });
  }
};
