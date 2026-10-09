/** Progress made while offline: kept in IndexedDB, then sent to the server once there is a connection. Browser only. */
import { deletePendingProgress, listPendingProgress, putPendingProgress } from "./db";
import { currentOfflineViewer } from "./viewer";
import type { PendingProgress } from "./types";

export const progressKey = (viewerId: string, ownerKind: string, ownerId: string) => `${viewerId}:${ownerKind}:${ownerId}`;

/** Keeps progress for the profile using this browser (nothing is kept when none is known). */
export async function queueProgress(p: Omit<PendingProgress, "key" | "at" | "viewerId">): Promise<void> {
  const viewerId = currentOfflineViewer();
  if (!viewerId) return;
  await putPendingProgress({ ...p, viewerId, key: progressKey(viewerId, p.ownerKind, p.ownerId), at: Date.now() }).catch(() => undefined);
}

/** The progress waiting for this item and profile, if any. */
export async function pendingProgressFor(ownerKind: string, ownerId: string): Promise<PendingProgress | undefined> {
  const viewerId = currentOfflineViewer();
  if (!viewerId) return undefined;
  return (await listPendingProgress().catch(() => [])).find((p) => p.key === progressKey(viewerId, ownerKind, ownerId));
}

/**
 * Sends the waiting progress that belongs to the profile using this browser now (another profile's waits for its own turn); whatever the
 * server refuses is dropped (it can't be fixed by retrying), whatever can't be reached stays.
 */
export async function flushProgress(): Promise<number> {
  let sent = 0;
  const viewerId = currentOfflineViewer();
  if (!viewerId) return 0;
  for (const p of (await listPendingProgress().catch(() => [])).filter((x) => x.viewerId === viewerId)) {
    try {
      const res = await fetch("/api/watch-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerKind: p.ownerKind, ownerId: p.ownerId, positionSeconds: p.positionSeconds, durationSeconds: p.durationSeconds, finished: p.finished }),
      });
      if (res.status >= 500 || res.status === 401 || res.status === 429) continue; // try again later
      await deletePendingProgress(p.key);
      if (res.ok) sent++;
    } catch {
      return sent; // no connection
    }
  }
  return sent;
}
