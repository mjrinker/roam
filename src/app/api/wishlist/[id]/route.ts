import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { changeStatus, removeWish, serverOfWish, setNote } from "@/lib/wishlist/service";
import { notFound, readOnlyResponse, UUID, wishActor } from "@/lib/wishlist/http";

const body = z.union([z.object({ action: z.enum(["claim", "unclaim", "got", "reopen"]) }).strict(), z.object({ note: z.string().max(2000).nullable() }).strict()]);

/** Changes a wish: `{ action: "claim" | "unclaim" | "got" | "reopen" }` (I'll buy it, not me, it's got, wanted again) or `{ note }`. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/wishlist/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  const serverId = await serverOfWish(db, id);
  if (!serverId) return notFound();
  const r = await wishActor(serverId);
  if ("response" in r) return r.response;
  if (r.who.readOnly) return readOnlyResponse();
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const result = "action" in parsed.data ? await changeStatus(db, serverId, r.who.accountId, r.who.isAdmin, id, parsed.data.action) : await setNote(db, serverId, r.who.accountId, r.who.isAdmin, id, parsed.data.note);
  return result.ok ? NextResponse.json(result.value) : NextResponse.json({ error: result.error }, { status: result.status });
}

/** Takes a wish off the list: the household that asked for it, or the server's admin. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/wishlist/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  const serverId = await serverOfWish(db, id);
  if (!serverId) return notFound();
  const r = await wishActor(serverId);
  if ("response" in r) return r.response;
  if (r.who.readOnly) return readOnlyResponse();
  const result = await removeWish(db, serverId, r.who.accountId, r.who.isAdmin, id);
  return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: result.error }, { status: result.status });
}
