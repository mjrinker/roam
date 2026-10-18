/** Watching-together rooms: a shared play state for one movie or episode, followed by the members' players (see sync.ts). */
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { watchRooms } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** A room nobody has looked into for this long is over. */
export const ROOM_IDLE_MS = 2 * 3600_000;
/** Someone who hasn't looked in for this long is no longer shown as watching. */
export const PRESENT_MS = 15_000;
export const MAX_MEMBERS = 8;

export interface RoomView {
  id: string;
  serverId: string;
  ownerKind: "title" | "episode";
  ownerId: string;
  state: { playing: boolean; position: number; rate: number; seq: number; at: number; now: number };
  /** Names of those watching now. */
  watching: string[];
}

export async function createRoom(ex: Db, args: { serverId: string; ownerKind: "title" | "episode"; ownerId: string; viewerId: string; name: string; now?: Date }): Promise<string> {
  const now = args.now ?? new Date();
  const [row] = await ex
    .insert(watchRooms)
    .values({ serverId: args.serverId, ownerKind: args.ownerKind, ownerId: args.ownerId, createdBy: args.viewerId, stateAt: now, members: { [args.viewerId]: { name: args.name, seenAt: now.toISOString() } } })
    .returning({ id: watchRooms.id });
  return row.id;
}

export async function roomOwner(ex: Db, id: string): Promise<{ serverId: string; ownerKind: "title" | "episode"; ownerId: string } | null> {
  const [r] = await ex.select({ serverId: watchRooms.serverId, ownerKind: watchRooms.ownerKind, ownerId: watchRooms.ownerId }).from(watchRooms).where(eq(watchRooms.id, id)).limit(1);
  return r && (r.ownerKind === "title" || r.ownerKind === "episode") ? { serverId: r.serverId, ownerKind: r.ownerKind, ownerId: r.ownerId } : null;
}

export type SyncResult = { ok: true; room: RoomView } | { ok: false; reason: "gone" | "full" };

/**
 * One look into a room by a member: notes that they are here, applies the change they made (if any), and answers with the shared state.
 * Last change wins. A room idle for ROOM_IDLE_MS is gone; a ninth member is turned away.
 */
export async function syncRoom(ex: Db, id: string, viewer: { id: string; name: string }, set: { playing: boolean; position: number; rate?: number } | null, now: Date = new Date()): Promise<SyncResult> {
  const [room] = await ex.select().from(watchRooms).where(eq(watchRooms.id, id)).limit(1);
  if (!room || (room.ownerKind !== "title" && room.ownerKind !== "episode")) return { ok: false, reason: "gone" };
  const lastSeen = Math.max(...Object.values(room.members).map((m) => Date.parse(m.seenAt)), room.stateAt.getTime());
  if (now.getTime() - lastSeen > ROOM_IDLE_MS) return { ok: false, reason: "gone" };
  if (!room.members[viewer.id] && Object.keys(room.members).length >= MAX_MEMBERS) return { ok: false, reason: "full" };
  const members = { ...room.members, [viewer.id]: { name: viewer.name, seenAt: now.toISOString() } };
  const change = set
    ? { playing: set.playing, positionSeconds: Math.max(0, set.position), rate: set.rate && set.rate > 0 && set.rate <= 4 ? set.rate : room.rate, seq: room.seq + 1, stateAt: now }
    : {};
  await ex.update(watchRooms).set({ members, ...change }).where(eq(watchRooms.id, id));
  const next = { playing: room.playing, positionSeconds: room.positionSeconds, rate: room.rate, seq: room.seq, stateAt: room.stateAt, ...change };
  return {
    ok: true,
    room: {
      id,
      serverId: room.serverId,
      ownerKind: room.ownerKind,
      ownerId: room.ownerId,
      state: { playing: next.playing, position: next.positionSeconds, rate: next.rate, seq: next.seq, at: next.stateAt.getTime(), now: now.getTime() },
      watching: Object.values(members).filter((m) => now.getTime() - Date.parse(m.seenAt) <= PRESENT_MS).map((m) => m.name),
    },
  };
}
