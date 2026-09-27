import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin, getCurrentProfile } from "@/lib/auth/guards";
import { resolveServerIdForTitle } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { libraries, titles } from "@/lib/db/schema";
import { narratorHintForTitle } from "@/lib/scan/audiobooks";
import { checkRateLimit } from "@/lib/rate-limit";
import { AudibleRateLimitedError, AudibleUnavailableError, searchAudible } from "@/lib/audible/client";
import { narratorSimilarity } from "@/lib/audible/match";
import type { AudibleSearchResult } from "@/lib/audible/parse";

export type AudibleSearchResultDto = AudibleSearchResult;

const querySchema = z.object({
  titleId: z.string().uuid(),
  q: z.string().trim().min(1).max(200),
  author: z.string().trim().max(200).optional(),
});

/**
 * Admin-only Audible catalog search for fixing an audiobook's match. Scoped
 * to a title so the caller must be an admin of the server that owns it (and
 * so the search uses that library's Audible region), and rate-limited since
 * it proxies a third-party service.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    titleId: url.searchParams.get("titleId"),
    q: url.searchParams.get("q"),
    author: url.searchParams.get("author") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "Missing titleId or q" }, { status: 400 });

  const serverId = await resolveServerIdForTitle(parsed.data.titleId);
  if (!serverId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const profile = await getCurrentProfile();
  if (!profile || !(await checkRateLimit(profile.id, "audible_search", 20, 60))) {
    return NextResponse.json({ error: "Too many searches — try again in a minute." }, { status: 429 });
  }

  const [row] = await db
    .select({ title: titles, region: libraries.audibleRegion })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(eq(titles.id, parsed.data.titleId))
    .limit(1);
  if (!row || row.title.kind !== "audiobook") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const narrators = await narratorHintForTitle(row.title);

  try {
    const results = await searchAudible({ title: parsed.data.q, author: parsed.data.author }, row.region);
    // Results whose narrator matches the files' tag come first (the picker is a
    // human decision, so nothing is dropped, only reordered).
    const ranked = narrators
      ? [...results].sort(
          (a, b) => narratorSimilarity(narrators, b.narrators) - narratorSimilarity(narrators, a.narrators)
        )
      : results;
    return NextResponse.json({
      results: ranked.slice(0, 10) satisfies AudibleSearchResultDto[],
      narratorHint: narrators,
    });
  } catch (err) {
    if (err instanceof AudibleRateLimitedError) {
      return NextResponse.json({ error: "Audible is rate limiting requests. Try again shortly." }, { status: 429 });
    }
    if (err instanceof AudibleUnavailableError) {
      return NextResponse.json({ error: "Audible is unavailable right now." }, { status: 502 });
    }
    throw err;
  }
}
