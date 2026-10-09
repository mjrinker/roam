/**
 * The download engine (browser only): one item at a time is saved file by file into the browser's storage, resuming where it stopped after
 * an interruption, asking for fresh addresses when Box's expire. State lives in memory, mirrored to IndexedDB at the points that matter,
 * and is observed with `subscribe` (see use-downloads.ts).
 */
import { deleteDownload, getDownload, listDownloads, putDownload } from "./db";
import type { DownloadOption, DownloadOptions } from "./options";
import { fetchFileUrls, PlanError, planDownload } from "./plan";
import { cancelSave, offlineStorageSupported, removeFiles, requestPersistence, saveFile, savedSizes, SaveError, storageUsage } from "./storage";
import { downloadId, type DownloadRecord } from "./types";

const records = new Map<string, DownloadRecord>();
const listeners = new Set<() => void>();
let snapshot: DownloadRecord[] = [];
let loaded: Promise<void> | null = null;
let activeId: string | null = null;
const queue: string[] = [];
const MAX_URL_REFRESHES = 4;
/** A dropped connection is tried again from where it stopped this many times (with growing waits) before the download is marked stopped. */
const MAX_RETRIES = 6;

function publish() {
  snapshot = [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current downloads, newest first (the same array until something changes). */
export function getSnapshot(): DownloadRecord[] {
  return snapshot;
}

/** Bytes saved so far for a record, counting the file in progress. */
export function savedBytes(record: DownloadRecord): number {
  return record.files.reduce((n, f) => n + (f.done ? (f.expected ?? f.bytes) : f.bytes), 0);
}

/** Loads what is stored; downloads that were running when the page closed start again. Safe to call many times. */
export function initDownloads(): Promise<void> {
  loaded ??= (async () => {
    if (!offlineStorageSupported()) return;
    for (const r of await listDownloads()) records.set(r.id, r);
    // A download interrupted by closing the page is paused; it carries on by itself when the app is opened again with a connection.
    const interrupted = [...records.values()].filter((r) => r.status === "downloading");
    for (const r of interrupted) r.status = "paused";
    publish();
    if (typeof window !== "undefined") window.addEventListener("online", () => interrupted.forEach((r) => void resumeDownload(r.id)));
    if (typeof navigator === "undefined" || navigator.onLine) for (const r of interrupted) void resumeDownload(r.id);
  })();
  return loaded;
}

function update(record: DownloadRecord, persist = true) {
  records.set(record.id, record);
  publish();
  if (persist) void putDownload(record).catch(() => undefined);
}

/** Starts saving one version of an item. Throws a readable error when it can't begin (no room, not reachable). */
export async function startDownload(serverId: string, options: DownloadOptions, choice: DownloadOption): Promise<void> {
  if (!offlineStorageSupported()) throw new Error("This browser can't save downloads. Try the installed app, or Chrome, Edge, Firefox or Safari.");
  await initDownloads();
  const id = downloadId(options.kind, options.ownerKind, options.ownerId, choice.label);
  if (records.get(id)?.status === "complete") return;
  const space = await storageUsage();
  if (space && choice.sizeBytes && choice.sizeBytes > space.quota - space.usage) throw new Error("There isn't enough room on this device for that download.");
  await requestPersistence();
  const { record, urls } = await planDownload(serverId, options, choice);
  update(record);
  urlCache.set(id, urls);
  enqueue(id);
}

const urlCache = new Map<string, string[]>();

function enqueue(id: string) {
  if (activeId === id || queue.includes(id)) return;
  queue.push(id);
  void pump();
}

async function pump() {
  if (activeId !== null) return;
  const id = queue.shift();
  if (!id) return;
  activeId = id;
  try {
    await run(id);
  } finally {
    activeId = null;
    void pump();
  }
}

async function run(id: string) {
  let record = records.get(id);
  if (!record) return;
  record = { ...record, status: "downloading", error: null };
  update(record);
  let refreshes = 0;
  let retries = 0;
  try {
    for (let i = 0; i < record.files.length; i++) {
      if (record.files[i].done) continue;
      for (;;) {
        const current = records.get(id);
        if (!current || current.status === "paused") return; // paused or removed meanwhile
        let urls = urlCache.get(id);
        if (!urls) {
          urls = await fetchFileUrls(current);
          urlCache.set(id, urls);
        }
        const file = current.files[i];
        const startAt = (await savedSizes([file.name]))[file.name] ?? 0;
        let lastPersist = 0;
        try {
          const bytes = await saveFile({
            jobId: `${id}#${i}`,
            name: file.name,
            url: urls[i],
            startAt,
            expected: file.expected,
            onProgress: (b) => {
              const now = records.get(id);
              if (!now) return;
              const files = now.files.map((f, k) => (k === i ? { ...f, bytes: b } : f));
              update({ ...now, files }, Date.now() - lastPersist > 5000 && !!(lastPersist = Date.now()));
            },
          });
          const now = records.get(id);
          if (!now) return;
          update({ ...now, files: now.files.map((f, k) => (k === i ? { ...f, bytes, expected: f.expected ?? bytes, done: true } : f)) });
          break;
        } catch (err) {
          if (err instanceof SaveError && err.aborted) return;
          // An address that has expired is answered with 401/403/404/410; ask for fresh ones and carry on from the same byte.
          if (err instanceof SaveError && [401, 403, 404, 410].includes(err.status) && refreshes < MAX_URL_REFRESHES) {
            refreshes++;
            urlCache.delete(id);
            continue;
          }
          // A dropped connection: wait a little and carry on from the same byte, unless the device is offline (then wait for it to return).
          const offline = typeof navigator !== "undefined" && !navigator.onLine;
          if (err instanceof SaveError && err.status === 0 && !offline && retries < MAX_RETRIES) {
            retries++;
            await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (retries - 1), 30_000)));
            continue;
          }
          throw err;
        }
      }
    }
    const done = records.get(id);
    if (done) update({ ...done, status: "complete", error: null, completedAt: Date.now() });
    urlCache.delete(id);
  } catch (err) {
    const now = records.get(id);
    if (!now) return;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    update({
      ...now,
      status: offline ? "paused" : "error",
      error: err instanceof PlanError || err instanceof SaveError ? err.message : "The download stopped.",
    });
  }
}

/** Carries on a paused or failed download from where it got to. */
export async function resumeDownload(id: string): Promise<void> {
  await initDownloads();
  const r = records.get(id);
  if (!r || r.status === "complete") return;
  update({ ...r, status: "downloading", error: null }, true);
  enqueue(id);
}

/** Stops a running download; what is saved is kept so it can carry on. */
export async function pauseDownload(id: string): Promise<void> {
  const r = records.get(id);
  if (!r || r.status === "complete") return;
  update({ ...r, status: "paused" });
  const index = queue.indexOf(id);
  if (index >= 0) queue.splice(index, 1);
  r.files.forEach((_f, i) => cancelSave(`${id}#${i}`));
}

/** Removes a download and everything saved for it. */
export async function removeDownload(id: string): Promise<void> {
  const r = records.get(id) ?? (await getDownload(id));
  if (!r) return;
  records.delete(id);
  urlCache.delete(id);
  const index = queue.indexOf(id);
  if (index >= 0) queue.splice(index, 1);
  r.files.forEach((_f, i) => cancelSave(`${id}#${i}`));
  publish();
  // The record goes first, so a page closed half way never lists a download whose files are gone.
  await deleteDownload(id);
  await removeFiles(r.files.map((f) => f.name));
}

/** The finished download of an item (any version), preferring the one named, or null. */
export function findCompleteDownload(kind: DownloadRecord["kind"], ownerKind: DownloadRecord["ownerKind"], ownerId: string, version?: string): DownloadRecord | null {
  const matches = [...records.values()].filter((r) => r.status === "complete" && r.kind === kind && r.ownerKind === ownerKind && r.ownerId === ownerId);
  return matches.find((r) => version !== undefined && r.version === version) ?? matches[0] ?? null;
}
