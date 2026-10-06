import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { parseSearch } from "@/lib/photos/search";
import { listMonths } from "@/lib/photos/timeline";
import { checkRateLimit } from "@/lib/rate-limit";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/** Month-by-month counts for the timeline's scrubber, narrowed exactly like the listing (favorites, search, access, age). */
export async function GET(request: Request, ctx: RouteContext<"/api/libraries/[id]/photos/months">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId) return notFound();
  const member = await getCurrentServerMember(serverId);
  if (!member) return notFound();
  if (!(await checkRateLimit(member.profile.id, "photo_months", 120, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  }
  const params = new URL(request.url).searchParams;
  const level = z.enum(["day", "month", "year"]).safeParse(params.get("level") ?? "month");
  if (!level.success) return NextResponse.json({ error: "Invalid request" }, { status: 400, headers });
  const months = await listMonths(db, {
    actor: libraryActor(member, serverId),
    viewer: member.viewer,
    viewerId: member.viewer.id,
    libraryId: id,
    favoritesOnly: params.get("view") === "favorites",
    search: parseSearch(params.get("q")),
    level: level.data,
  });
  if (!months) return notFound();
  return NextResponse.json({ months }, { headers });
}
