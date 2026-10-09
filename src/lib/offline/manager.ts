/**
 * The download engine (browser only): one item at a time is saved file by file into the browser's storage, resuming where it stopped after
 * an interruption, asking for fresh addresses when Box's expire. State lives in memory, mirrored to IndexedDB at the points that matter,
 * and is observed with `subscribe` (see use-downloads.ts). Downloads belong to the profile that made them (see viewer.ts).
 */
import { deleteDownload, getDownload, listDownloads, putDownload } from "./db";
import type { DownloadOption, DownloadOptions } from "./options";
import { fetchFileUrls, PlanError, planDownload } from "./plan";
import { cancelSave, offlineStorageSupported, removeFiles, requestPersistence, saveFile, savedSizes, SaveError, storageUsage } from "./storage";
import { downloadId, type DownloadRecord } from "./types";
import { currentOfflineViewer } from "./viewer";

const records = new Map<string, DownloadRecord>();
const listeners = new Set<() => void>();
let snapshot: DownloadRecord[] = [];
let loaded: Promise<void> | null = null;
let activeId: string | null = null;
/** The run in progress for each download, so removing one can wait for its file to be let go of. */
const running = new Map<string, Promise<void>>();
/** Each run gets a number; pausing or removing a download changes it, and the older run then stops at its next step. */
const generation = new Map<string, number>();
let nextGeneration = 1;
/** The save job (worker request) currently open for each download. */
const openJob = new Map<string, string>();
const queue: string[] = [];
/** Downloads to carry on by themselves when the connection returns (interrupted by closing the page or by going offline). */
const autoResume = new Set<string>();
const urlCache = new Map<string, string[]>();
const MAX_URL_REFRESHES = 4;
/** A dropped connection is tried again from where it stopped this many times (with growing waits) before the download is marked stopped. */
const MAX_RETRIES = 6;

function publish() {
  const viewer = currentOfflineViewer();
  snapshot = [...records.values()].filter((r) => r.viewerId === viewer).sort((a, b) => b.createdAt - a.createdAt);
  for (const l of listeners) l();
}

/** The signed-in profile changed (the marker was written): the lists show that profile's downloads. */
export function notifyViewerChanged() {
  publish();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current profile's downloads, newest first (the same array until something changes). */
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
    for (const r of records.values()) {
      if (r.status === "downloading") {
        r.status = "paused";
        autoResume.add(r.id);
      }
    }
    publish();
    if (typeof window !== "undefined") window.addEventListener("online", resumeInterrupted);
    if (typeof navigator === "undefined" || navigator.onLine) resumeInterrupted();
  })();
  return loaded;
}

function resumeInterrupted() {
  for (const id of [...autoResume]) void resumeDownload(id);
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
  const viewerId = currentOfflineViewer();
  if (!viewerId) throw new Error("Open Roam again and sign in to download.");
  const id = downloadId(options.kind, options.ownerKind, options.ownerId, choice.label);
  const existing = records.get(id);
  if (existing && existing.viewerId !== viewerId) throw new Error("Another profile on this device has already downloaded that. Ask them to remove it first.");
  if (existing?.status === "complete") return;
  const space = await storageUsage();
  if (space && choice.sizeBytes && choice.sizeBytes > space.quota - space.usage) throw new Error("There isn't enough room on this device for that download.");
  await requestPersistence();
  const { record, urls } = await planDownload(serverId, viewerId, options, choice);
  update(record);
  urlCache.set(id, urls);
  enqueue(id);
}

function enqueue(id: string) {
  if (queue.includes(id)) return;
  queue.push(id);
  void pump();
}

async function pump() {
  if (activeId !== null) return;
  const id = queue.shift();
  if (!id) return;
  activeId = id;
  const mine = nextGeneration++;
  generation.set(id, mine);
  const done = run(id, mine).catch(() => undefined);
  running.set(id, done);
  try {
    await done;
  } finally {
    running.delete(id);
    activeId = null;
    void pump();
  }
}

async function run(id: string, mine: number) {
  const stillMine = () => generation.get(id) === mine && records.has(id);
  const first = records.get(id);
  if (!first) return;
  update({ ...first, status: "downloading", error: null });
  let refreshes = 0;
  let retries = 0;
  try {
    for (let i = 0; i < first.files.length; i++) {
      if (records.get(id)?.files[i].done) continue;
      for (;;) {
        if (!stillMine()) return; // paused or removed meanwhile
        const current = records.get(id)!;
        let urls = urlCache.get(id);
        if (!urls) {
          urls = await fetchFileUrls(current);
          urlCache.set(id, urls);
          if (!stillMine()) return;
        }
        const file = current.files[i];
        const startAt = (await savedSizes([file.name]))[file.name] ?? 0;
        if (!stillMine()) return;
        const jobId = `${id}#${i}@${mine}`;
        let lastPersist = 0;
        openJob.set(id, jobId);
        try {
          const bytes = await saveFile({
            jobId,
            name: file.name,
            url: urls[i],
            startAt,
            expected: file.expected,
            onProgress: (b) => {
              const now = records.get(id);
              if (!now || !stillMine()) return;
              const files = now.files.map((f, k) => (k === i ? { ...f, bytes: b } : f));
              const persist = Date.now() - lastPersist > 5000;
              if (persist) lastPersist = Date.now();
              update({ ...now, files }, persist);
            },
          });
          if (!stillMine()) return;
          const now = records.get(id)!;
          update({ ...now, files: now.files.map((f, k) => (k === i ? { ...f, bytes, expected: f.expected ?? bytes, done: true } : f)) });
          break;
        } catch (err) {
          if (!stillMine() || (err instanceof SaveError && err.aborted)) return;
          // An address that has expired is answered with 401/403/404/410; ask for fresh ones and carry on from the same byte.
          if (err instanceof SaveError && [401, 403, 404, 410].includes(err.status) && refreshes < MAX_URL_REFRESHES) {
            refreshes++;
            urlCache.delete(id);
            continue;
          }
          // A dropped connection: wait a little and carry on from the same byte, unless the device is offline (then wait for it to return).
          const offline = typeof navigator !== "undefined" && !navigator.onLine;
          if (err instanceof SaveError && err.status === 0 && !err.fatal && !offline && retries < MAX_RETRIES) {
            retries++;
            await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (retries - 1), 30_000)));
            continue;
          }
          throw err;
        } finally {
          if (openJob.get(id) === jobId) openJob.delete(id);
        }
      }
    }
    if (!stillMine()) return;
    update({ ...records.get(id)!, status: "complete", error: null, completedAt: Date.now() });
    autoResume.delete(id);
    urlCache.delete(id);
  } catch (err) {
    if (!stillMine()) return;
    const now = records.get(id)!;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    if (offline) autoResume.add(id);
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
  if (!r || r.status === "complete" || r.status === "downloading" || r.viewerId !== currentOfflineViewer()) return;
  autoResume.delete(id);
  update({ ...r, status: "downloading", error: null }, true);
  enqueue(id);
}

function stopRun(id: string) {
  generation.set(id, nextGeneration++); // the run in progress stops at its next step
  const job = openJob.get(id);
  if (job) cancelSave(job);
  const index = queue.indexOf(id);
  if (index >= 0) queue.splice(index, 1);
}

/** Stops a running download; what is saved is kept so it can carry on. */
export async function pauseDownload(id: string): Promise<void> {
  const r = records.get(id);
  if (!r || r.status === "complete") return;
  autoResume.delete(id);
  stopRun(id);
  update({ ...r, status: "paused" });
}

/** Removes a download and everything saved for it. */
export async function removeDownload(id: string): Promise<void> {
  const r = records.get(id) ?? (await getDownload(id));
  if (!r) return;
  autoResume.delete(id);
  stopRun(id);
  records.delete(id);
  urlCache.delete(id);
  publish();
  // The record goes first, so a page closed half way never lists a download whose files are gone.
  await deleteDownload(id);
  // Its files can only be deleted once the worker has let go of them.
  await running.get(id);
  await removeFiles(r.files.map((f) => f.name)).catch(() => undefined);
}

/** The finished download of an item for the current profile (the named version preferred), or null. */
export function findCompleteDownload(kind: DownloadRecord["kind"], ownerKind: DownloadRecord["ownerKind"], ownerId: string, version?: string): DownloadRecord | null {
  const viewer = currentOfflineViewer();
  const matches = [...records.values()].filter((r) => r.viewerId === viewer && r.status === "complete" && r.kind === kind && r.ownerKind === ownerKind && r.ownerId === ownerId);
  return matches.find((r) => version !== undefined && r.version === version) ?? matches[0] ?? null;
}
