/** What a player does when the server tracks ownership: notice that a copy isn't available, hold its place, and ask to be told when one is free. */

export interface Unavailable {
  code: "withdrawn" | "busy";
  error: string;
  unit: { titleId: string; seasonId: string | null };
  watching: boolean;
}

/** The "not available" answer (423) from a play request, or null for any other response. */
export async function readUnavailable(res: Response | null): Promise<Unavailable | null> {
  if (!res || res.status !== 423) return null;
  const body = (await res.json().catch(() => null)) as Partial<Unavailable> | null;
  if (!body || (body.code !== "withdrawn" && body.code !== "busy") || !body.unit) return null;
  return { code: body.code, error: body.error ?? "This isn't available right now.", unit: body.unit, watching: !!body.watching };
}

const json = { "Content-Type": "application/json" };

export async function setWatching(unit: Unavailable["unit"], on: boolean): Promise<boolean> {
  const res = await fetch("/api/playback/watch", { method: on ? "PUT" : "DELETE", headers: json, body: JSON.stringify(unit) }).catch(() => null);
  return !!res && res.ok;
}

/** How often a player says it is still there (a place is let go after 90 seconds of silence). */
export const HEARTBEAT_MS = 30_000;

/**
 * Keeps this player's place while it is open. `paused` is asked each time. `onLost` is called if the place can no longer be held
 * (the server says the title is no longer available to this viewer). Returns a function that stops and lets go of the place.
 */
export function holdPlace(ownerKind: string, ownerId: string, paused: () => boolean, onLost: (u: Unavailable) => void): () => void {
  let stopped = false;
  const beat = async () => {
    const res = await fetch("/api/playback/beat", { method: "POST", headers: json, body: JSON.stringify({ ownerKind, ownerId, paused: paused() }) }).catch(() => null);
    if (stopped) return;
    const lost = await readUnavailable(res);
    if (lost) onLost(lost);
  };
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    releasePlace();
  };
}

/** Lets go of this viewer's place, also when the page is being closed. */
export function releasePlace(): void {
  try {
    if (!navigator.sendBeacon?.("/api/playback/end")) void fetch("/api/playback/end", { method: "POST", keepalive: true }).catch(() => undefined);
  } catch {
    // Nothing to do: the place is let go after a minute and a half anyway.
  }
}
