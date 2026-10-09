import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { MAX_SELECT_IDS } from "@/lib/libraries/folder-browse";
import { selectedSongIds } from "@/lib/music/browse";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });
const bodySchema = z.object({ albumIds: z.array(z.string().uuid()).max(1000).default([]), artistIds: z.array(z.string().uuid()).max(1000).default([]) }).refine((v) => v.albumIds.length + v.artistIds.length > 0);

/** The songs of the albums and artists selected on a music library page (the bulk actions work on songs). Only songs this profile may see. */
export async function POST(request: Request, ctx: RouteContext<"/api/libraries/[id]/music-songs">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send albumIds and/or artistIds." }, { status: 400, headers });
  const serverId = await resolveServerIdForLibrary(id);
  const member = serverId ? await getCurrentServerMember(serverId) : null;
  if (!serverId || !member) return notFound();
  const result = await selectedSongIds(db, { actor: libraryActor(member, serverId), viewer: member.viewer, ...parsed.data, max: MAX_SELECT_IDS });
  return NextResponse.json(result, { headers });
}
