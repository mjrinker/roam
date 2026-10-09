import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { MAX_SELECT_IDS } from "@/lib/libraries/folder-browse";
import { musicCardIds } from "@/lib/music/browse";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/** Every album (or artist) of a music library, for "select all" (the page itself shows them a page at a time). */
export async function GET(request: Request, ctx: RouteContext<"/api/libraries/[id]/music-ids">) {
  const { id } = await ctx.params;
  const view = new URL(request.url).searchParams.get("view");
  if (!z.string().uuid().safeParse(id).success || (view !== "albums" && view !== "artists")) return notFound();
  const serverId = await resolveServerIdForLibrary(id);
  const member = serverId ? await getCurrentServerMember(serverId) : null;
  if (!serverId || !member) return notFound();
  const result = await musicCardIds(db, { actor: libraryActor(member, serverId), viewer: member.viewer, libraryId: id, view, max: MAX_SELECT_IDS });
  return result ? NextResponse.json(result, { headers }) : notFound();
}
