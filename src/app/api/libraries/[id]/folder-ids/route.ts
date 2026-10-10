import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { folderPlayableIds, normalizeFolderPath, parseFolderSearch, parseFolderSort } from "@/lib/libraries/folder-browse";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/** Every playable file directly in a folder of a video or audio library, for "select all" (the page itself shows them a page at a time). */
export async function GET(request: Request, ctx: RouteContext<"/api/libraries/[id]/folder-ids">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const params = new URL(request.url).searchParams;
  const path = normalizeFolderPath(params.get("path"));
  const sort = parseFolderSort(params.get("sort"), params.get("dir"));
  if (path === null) return notFound();
  const serverId = await resolveServerIdForLibrary(id);
  const member = serverId ? await getCurrentServerMember(serverId) : null;
  if (!serverId || !member) return notFound();
  const result = await folderPlayableIds(db, { actor: libraryActor(member, serverId), viewer: member.viewer, libraryId: id, path, sort, search: parseFolderSearch(params.get("q")) });
  return result ? NextResponse.json(result, { headers }) : notFound();
}
