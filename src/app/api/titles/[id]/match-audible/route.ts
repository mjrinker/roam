import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForTitle } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { refuseUnlessExternalMetadata } from "@/lib/libraries/kind";
import { libraries, titles } from "@/lib/db/schema";
import { AudibleRateLimitedError, AudibleUnavailableError } from "@/lib/audible/client";
import { matchAudiobookToAsin, resolveAudiobookChapters } from "@/lib/scan/audiobooks";

const bodySchema = z.object({ asin: z.string().regex(/^[A-Z0-9]{10}$/i) });

/** Admin pins an audiobook to a chosen Audible book (the audiobook counterpart of the TMDB match route). */
export async function POST(request: Request, ctx: RouteContext<"/api/titles/[id]/match-audible">) {
  const { id } = await ctx.params;

  const serverId = await resolveServerIdForTitle(id);
  if (!serverId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const refused = await refuseUnlessExternalMetadata(db, id);
  if (refused) return refused;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid ASIN" }, { status: 400 });

  const [row] = await db
    .select({ kind: titles.kind, region: libraries.audibleRegion })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(eq(titles.id, id))
    .limit(1);
  if (!row || row.kind !== "audiobook") return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await matchAudiobookToAsin(id, parsed.data.asin.toUpperCase(), row.region);
    // Rebuild chapters now that the ASIN changed (no-op until every part is probed).
    await resolveAudiobookChapters(id, row.region);
  } catch (err) {
    if (err instanceof AudibleRateLimitedError || err instanceof AudibleUnavailableError) {
      return NextResponse.json({ error: "Audible is unavailable right now. Try again shortly." }, { status: 502 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
