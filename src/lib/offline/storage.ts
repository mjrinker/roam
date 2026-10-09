/** Saving, reading and removing the downloaded files in the browser's private file storage (OPFS), through a worker. Browser only. */

const DIR = "roam-downloads";

export class SaveError extends Error {
  constructor(message: string, readonly status: number, readonly aborted = false) {
    super(message);
  }
}

type Out =
  | { type: "progress"; jobId: string; bytes: number }
  | { type: "done"; jobId: string; bytes: number }
  | { type: "error"; jobId: string; status: number; message: string; aborted?: boolean }
  | { type: "removed"; reqId: number }
  | { type: "sizes"; reqId: number; sizes: Record<string, number> };

let worker: Worker | null = null;
let nextId = 1;
const jobs = new Map<string, { onProgress: (bytes: number) => void; resolve: (bytes: number) => void; reject: (e: SaveError) => void }>();
const requests = new Map<number, (m: Out) => void>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./storage.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<Out>) => {
    const m = event.data;
    if (m.type === "removed" || m.type === "sizes") {
      requests.get(m.reqId)?.(m);
      return;
    }
    const job = jobs.get(m.jobId);
    if (!job) return;
    if (m.type === "progress") {
      job.onProgress(m.bytes);
      return;
    }
    jobs.delete(m.jobId);
    if (m.type === "done") job.resolve(m.bytes);
    else job.reject(new SaveError(m.message, m.status, m.aborted));
  };
  worker.onerror = () => {
    for (const [id, job] of jobs) {
      jobs.delete(id);
      job.reject(new SaveError("The download stopped", 0));
    }
  };
  return worker;
}

/** Whether this browser can save big files for offline use at all. */
export function offlineStorageSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory && typeof Worker !== "undefined" && typeof indexedDB !== "undefined";
}

/** Saves `url` into the file `name`, continuing from `startAt` bytes. Resolves with the file's final size. */
export function saveFile(args: { jobId: string; name: string; url: string; startAt: number; expected: number | null; onProgress: (bytes: number) => void }): Promise<number> {
  return new Promise((resolve, reject) => {
    jobs.set(args.jobId, { onProgress: args.onProgress, resolve, reject });
    ensureWorker().postMessage({ type: "download", jobId: args.jobId, file: args.name, url: args.url, startAt: args.startAt, expected: args.expected });
  });
}

export function cancelSave(jobId: string): void {
  worker?.postMessage({ type: "cancel", jobId });
}

function ask<T extends Out>(build: (reqId: number) => unknown): Promise<T> {
  return new Promise((resolve) => {
    const reqId = nextId++;
    requests.set(reqId, (m) => (requests.delete(reqId), resolve(m as T)));
    ensureWorker().postMessage(build(reqId));
  });
}

export async function removeFiles(names: string[]): Promise<void> {
  if (names.length > 0) await ask((reqId) => ({ type: "remove", reqId, names }));
}

/** How many bytes of each file are on disk (0 for one that doesn't exist). */
export async function savedSizes(names: string[]): Promise<Record<string, number>> {
  if (names.length === 0) return {};
  return (await ask<Extract<Out, { type: "sizes" }>>((reqId) => ({ type: "sizes", reqId, names }))).sizes;
}

/** A saved file ready to play (null when it isn't there). The File reads from disk as needed; it is not loaded into memory. */
export async function openSavedFile(name: string): Promise<File | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR);
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function storageUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return usage !== undefined && quota !== undefined ? { usage, quota } : null;
  } catch {
    return null;
  }
}

/** Asks the browser not to clear the downloads when it is short of space (it may or may not agree). */
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage.persist?.();
  } catch {
    // not available
  }
}
