import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { libraries, titles } from "@/lib/db/schema";
import { PHOTO_LIBRARY_KINDS } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";

const headers = { "Cache-Control": "no-store" };
const MAX_IDS = 500;

const body = z.object({ serverId: z.string().uuid(), ids: z.array(z.string().uuid()).min(1).max(MAX_IDS), screenshot: z.boolean() }).strict();

/**
 * Marks pictures as screenshots, or as not (one or many): `{ serverId, ids: [...], screenshot: true }`. Only the server's admin; pictures of other
 * servers, videos and anything that isn't in a photo library are ignored. A mark made here is kept: later scans don't change it. Answers `{ changed }`.
 */
export async function PUT(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400, headers });
  const { serverId, screenshot } = parsed.data;
  const ids = [...new Set(parsed.data.ids)];
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin || admin.viewer.role === "limited") return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  if (!(await checkRateLimit(admin.profile.id, "photo_screenshots", 60, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  const mine = db.select({ id: libraries.id }).from(libraries).where(and(eq(libraries.serverId, serverId), inArray(libraries.kind, [...PHOTO_LIBRARY_KINDS])));
  const changed = await db
    .update(titles)
    .set({ isScreenshot: screenshot, screenshotLocked: true })
    .where(and(inArray(titles.id, ids), eq(titles.kind, "photo"), inArray(titles.libraryId, mine)))
    .returning({ id: titles.id });
  return NextResponse.json({ changed: changed.length }, { headers });
}
