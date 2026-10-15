import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { ownershipGate } from "@/lib/ownership/gate";
import { json, notFound, readJson, uuid } from "@/lib/ownership/http";

const body = z.object({ ownerKind: z.enum(["title", "episode", "extra"]), ownerId: uuid, paused: z.boolean().optional() }).strict();

/** A player's heartbeat (every half minute while it is open): keeps its place when the server limits playing at once, and says if it has been lost. */
export async function POST(request: Request) {
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const auth = await authorizeOwner(data.ownerKind, data.ownerId);
  if (!auth.ok) return notFound();
  const blocked = await ownershipGate({ viewerId: auth.member.viewer.id, accountId: auth.member.profile.id }, data.ownerKind, data.ownerId, { take: true, paused: data.paused });
  return blocked ?? json({ ok: true });
}
