import { NextResponse } from "next/server";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { ownershipGate } from "@/lib/ownership/gate";
import { TracksError } from "./mp4-tracks";
import { ownedFile, type TrackFile } from "./service";
import type { PlayOwnerKind } from "@/lib/player/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Who may read a file's tracks: whoever may play its owner (the same checks as /api/play, except that this takes no place at the
 * server's limit on playing at once). Null file means 404, the same as a title the profile may not see.
 */
export async function trackAccess(ownerKind: string, ownerId: string, fileId: string): Promise<{ ok: true; serverId: string; file: TrackFile } | { ok: false; response: NextResponse }> {
  if ((ownerKind !== "title" && ownerKind !== "episode" && ownerKind !== "extra") || !UUID.test(ownerId) || !UUID.test(fileId)) return { ok: false, response: notFound() };
  const kind: PlayOwnerKind = ownerKind;
  const auth = await authorizeOwner(kind, ownerId);
  if (!auth.ok) return { ok: false, response: NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status }) };
  const blocked = await ownershipGate({ viewerId: auth.member.viewer.id, accountId: auth.member.profile.id }, kind, ownerId, { take: false });
  if (blocked) return { ok: false, response: blocked };
  const file = await ownedFile(kind, ownerId, fileId);
  if (!file) return { ok: false, response: notFound() };
  return { ok: true, serverId: auth.serverId, file };
}

/** A failure reading the file, as a response: what the file can't do is said plainly, anything else is a bad gateway. */
export function trackFailure(err: unknown): NextResponse {
  if (err instanceof TracksError) return NextResponse.json({ error: err.message }, { status: 422 });
  console.error("media-tracks:", err);
  return NextResponse.json({ error: "The file couldn't be read right now." }, { status: 502 });
}

export const PRIVATE_CACHE = { "Cache-Control": "private, max-age=3600" };
