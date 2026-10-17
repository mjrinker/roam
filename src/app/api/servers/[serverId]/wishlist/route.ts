import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { addWish, listWishes } from "@/lib/wishlist/service";
import { readOnlyResponse, wishActor } from "@/lib/wishlist/http";

const body = z
  .object({
    kind: z.string().max(20),
    title: z.string().max(1000),
    year: z.number().int().nullable().optional(),
    creator: z.string().max(1000).nullable().optional(),
    tmdbId: z.number().int().nullable().optional(),
    posterUrl: z.string().max(300).nullable().optional(),
    overview: z.string().max(5000).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

/** The server's shared wishlist, for any member: most wanted first, with who wants each and whether it is already on the server. */
export async function GET(_request: Request, ctx: RouteContext<"/api/servers/[serverId]/wishlist">) {
  const { serverId } = await ctx.params;
  const r = await wishActor(serverId);
  if ("response" in r) return r.response;
  const items = await listWishes(db, { serverId, actor: r.who.actor, viewer: r.who.viewer, accountId: r.who.accountId, isAdmin: r.who.isAdmin });
  return NextResponse.json({ items, canEdit: !r.who.readOnly }, { headers: { "Cache-Control": "no-store" } });
}

/** Adds a wish for the signed-in household (or joins the one already listed). 409 with `titleId` when it is already on the server. */
export async function POST(request: Request, ctx: RouteContext<"/api/servers/[serverId]/wishlist">) {
  const { serverId } = await ctx.params;
  const r = await wishActor(serverId);
  if ("response" in r) return r.response;
  if (r.who.readOnly) return readOnlyResponse();
  if (!(await checkRateLimit(r.who.accountId, "wishlist", 60, 600))) return NextResponse.json({ error: "Too many requests — slow down a little." }, { status: 429 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const result = await addWish(db, { serverId, actor: r.who.actor, viewer: r.who.viewer, accountId: r.who.accountId }, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.titleId ? { titleId: result.titleId } : {}) }, { status: result.status });
  return NextResponse.json(result.value, { status: result.value.joined ? 200 : 201 });
}
