/** Progress made while offline: kept in IndexedDB, then sent to the server once there is a connection. Browser only. */
import { deletePendingProgress, listPendingProgress, putPendingProgress } from "./db";
import type { PendingProgress } from "./types";

export const progressKey = (ownerKind: string, ownerId: string) => `${ownerKind}:${ownerId}`;

export async function queueProgress(p: Omit<PendingProgress, "key" | "at">): Promise<void> {
  await putPendingProgress({ ...p, key: progressKey(p.ownerKind, p.ownerId), at: Date.now() }).catch(() => undefined);
}

/** Sends everything waiting; whatever the server refuses is dropped (it can't be fixed by retrying), whatever can't be reached stays. */
export async function flushProgress(): Promise<number> {
  let sent = 0;
  for (const p of await listPendingProgress().catch(() => [])) {
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
