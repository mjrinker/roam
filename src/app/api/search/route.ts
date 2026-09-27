import { NextResponse } from "next/server";
import { z } from "zod";
import { asc, desc, eq, ilike, and, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, titles, type TitleKind } from "@/lib/db/schema";
import { getCurrentServerMember } from "@/lib/auth/guards";

export interface SearchResultDto {
  id: string;
  kind: TitleKind;
  name: string;
  year: number | null;
  posterUrl: string | null;
}

const querySchema = z.object({
  serverId: z.string().uuid(),
  q: z.string().trim().min(1).max(100),
});

const RESULT_LIMIT = 12;

/** Title search across every library in one of the caller's servers — powers the top-bar search box. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    serverId: url.searchParams.get("serverId"),
    q: url.searchParams.get("q"),
  });
  if (!parsed.success) {
    return NextResponse.json({ results: [] satisfies SearchResultDto[] });
  }

  const member = await getCurrentServerMember(parsed.data.serverId);
  if (!member) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Escape LIKE wildcards so a query of "100%" matches literally.
  const escaped = parsed.data.q.replace(/[\\%_]/g, (c) => `\\${c}`);

  const rows = await db
    .select({
      id: titles.id,
      kind: titles.kind,
      name: titles.name,
      year: titles.year,
      posterUrl: titles.posterUrl,
    })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(
      and(eq(libraries.serverId, parsed.data.serverId), ilike(titles.name, `%${escaped}%`))
    )
    // Titles that START with the query first, then alphabetical.
    .orderBy(desc(sql`${titles.name} ilike ${escaped + "%"}`), asc(titles.name))
    .limit(RESULT_LIMIT);

  return NextResponse.json({ results: rows satisfies SearchResultDto[] });
}
