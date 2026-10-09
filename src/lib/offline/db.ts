/** The offline records in IndexedDB: downloads, and progress made while offline. Browser only. */
import type { DownloadRecord, PendingProgress } from "./types";

const NAME = "roam-offline";
const VERSION = 1;

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("downloads", { keyPath: "id" });
      db.createObjectStore("progress", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opened = null;
      reject(req.error);
    };
  });
  return opened;
}

function run<T>(store: "downloads" | "progress", mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = work(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const listDownloads = () => run<DownloadRecord[]>("downloads", "readonly", (s) => s.getAll());
export const getDownload = (id: string) => run<DownloadRecord | undefined>("downloads", "readonly", (s) => s.get(id));
export const putDownload = (record: DownloadRecord) => run("downloads", "readwrite", (s) => s.put(record));
export const deleteDownload = (id: string) => run("downloads", "readwrite", (s) => s.delete(id));

export const listPendingProgress = () => run<PendingProgress[]>("progress", "readonly", (s) => s.getAll());
export const putPendingProgress = (p: PendingProgress) => run("progress", "readwrite", (s) => s.put(p));
export const deletePendingProgress = (key: string) => run("progress", "readwrite", (s) => s.delete(key));
