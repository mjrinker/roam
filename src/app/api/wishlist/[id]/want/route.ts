import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { serverOfWish, setWant } from "@/lib/wishlist/service";
import { notFound, readOnlyResponse, UUID, wishActor } from "@/lib/wishlist/http";

const body = z.object({ on: z.boolean() }).strict();

/** "I want this too" (`on: true`) or not any more. A wish nobody wants any more goes away. */
export async function PUT(request: Request, ctx: RouteContext<"/api/wishlist/[id]/want">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  const serverId = await serverOfWish(db, id);
  if (!serverId) return notFound();
  const r = await wishActor(serverId);
  if ("response" in r) return r.response;
  if (r.who.readOnly) return readOnlyResponse();
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const result = await setWant(db, serverId, r.who.accountId, id, parsed.data.on);
  return result.ok ? NextResponse.json(result.value) : NextResponse.json({ error: result.error }, { status: result.status });
}
