import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { authorizeSubtitles, parseOwner } from "@/lib/subtitles/http";
import { checkRateLimit } from "@/lib/rate-limit";
import { createRoom } from "@/lib/watch-together/service";

/** Starts watching together: a room for this movie or episode that other members of the server can join. Body `{ ownerKind: "title" | "episode", ownerId }`. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const owner = parseOwner(body?.ownerKind, body?.ownerId);
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await authorizeSubtitles(owner); // may this profile play it (movies, videos and episodes only)
  if (!access.ok) return access.response;
  const { member } = access.auth;
  if (!(await checkRateLimit(member.profile.id, "watch-together", 20, 3600))) return NextResponse.json({ error: "Too many rooms: try again later." }, { status: 429 });
  const id = await createRoom(db, { serverId: access.auth.serverId, ownerKind: owner.kind, ownerId: owner.id, viewerId: member.viewer.id, name: member.viewer.name });
  return NextResponse.json({ id, serverId: access.auth.serverId, ownerKind: owner.kind, ownerId: owner.id }, { status: 201 });
}
