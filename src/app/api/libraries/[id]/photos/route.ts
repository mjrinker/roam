import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { parseSearch } from "@/lib/photos/search";
import { listTimeline, timelineCursorSchema } from "@/lib/photos/timeline";
import { decodeCursor, encodeCursor } from "@/lib/playlists/http";
import { checkRateLimit } from "@/lib/rate-limit";

const PAGE = 60;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/**
 * The next page of a photo library's timeline, for the page's infinite scroll. Same visibility rules as
 * the page itself (library access, age limit, photo libraries only), and every failure is the same 404.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/libraries/[id]/photos">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId) return notFound();
  const member = await getCurrentServerMember(serverId);
  if (!member) return notFound();
  if (!(await checkRateLimit(member.profile.id, "photo_timeline", 600, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  }

  const after = decodeCursor(new URL(request.url).searchParams.get("after"), timelineCursorSchema);
  if (after === "invalid") return NextResponse.json({ error: "Invalid cursor" }, { status: 400, headers });
  const before = decodeCursor(new URL(request.url).searchParams.get("before"), timelineCursorSchema);
  if (before === "invalid") return NextResponse.json({ error: "Invalid cursor" }, { status: 400, headers });

  const params = new URL(request.url).searchParams;
  const page = await listTimeline(db, {
    actor: libraryActor(member, serverId),
    viewer: member.viewer,
    viewerId: member.viewer.id,
    libraryId: id,
    after,
    before,
    limit: PAGE,
    favoritesOnly: params.get("view") === "favorites",
    search: parseSearch(params.get("q")),
    month: params.get("month"),
  });
  if (!page) return notFound();
  return NextResponse.json({ items: page.items, next: page.next ? encodeCursor(page.next) : null, prev: page.prev ? encodeCursor(page.prev) : null }, { headers });
}
