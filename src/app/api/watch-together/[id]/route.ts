import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { authorizeSubtitles } from "@/lib/subtitles/http";
import { roomOwner, syncRoom } from "@/lib/watch-together/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const body = z.object({ set: z.object({ playing: z.boolean(), position: z.number().min(0).max(1_000_000), rate: z.number().min(0.25).max(4).optional() }).strict().optional() }).strict();

/**
 * One look into a room: the player says it is here (and, with `set`, what the viewer just did: played, paused, jumped) and gets the shared
 * state back. Only someone who may play the title, on its server, can look.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/watch-together/[id]">) {
  const { id } = await ctx.params;
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!UUID.test(id)) return notFound();
  const owner = await roomOwner(db, id);
  if (!owner) return notFound();
  const access = await authorizeSubtitles({ kind: owner.ownerKind, id: owner.ownerId });
  if (!access.ok || access.auth.serverId !== owner.serverId) return notFound();
  const parsed = body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { viewer } = access.auth.member;
  const result = await syncRoom(db, id, { id: viewer.id, name: viewer.name }, parsed.data.set ?? null);
  if (!result.ok) return result.reason === "full" ? NextResponse.json({ error: "This room is full.", code: "full" }, { status: 409 }) : NextResponse.json({ error: "This room has ended.", code: "gone" }, { status: 410 });
  return NextResponse.json(result.room, { headers: { "Cache-Control": "no-store" } });
}
