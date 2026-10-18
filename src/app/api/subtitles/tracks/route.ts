import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { subtitleTracks } from "@/lib/db/schema";
import { authorizeSubtitles, parseOwner } from "@/lib/subtitles/http";
import { MAX_SAVED_CUES } from "@/lib/subtitles/tracks";
import { languageCode3 } from "@/lib/viewers/audio-languages";

const MAX_TRACKS_PER_TITLE = 12;

function validCues(value: unknown): [number, number, string][] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SAVED_CUES) return null;
  const out: [number, number, string][] = [];
  for (const c of value) {
    if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number" || typeof c[2] !== "string" || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || c[1] < c[0] || c[0] < 0 || c[2].length > 2000) return null;
    out.push([c[0], c[1], c[2]]);
  }
  return out;
}

/** Keeps subtitles with a movie or episode for everyone who can play it. Only the server's admin may. Body: `{ ownerKind, ownerId, language?, label, cues }`. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const owner = parseOwner(body?.ownerKind, body?.ownerId);
  if (!body || !owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await authorizeSubtitles(owner);
  if (!access.ok) return access.response;
  const { member } = access.auth;
  if (member.role !== "admin" || member.viewer.role === "limited") return NextResponse.json({ error: "Only the server's admin can keep subtitles for everyone." }, { status: 403 });
  const cues = validCues(body.cues);
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
  if (!cues || !label) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(subtitleTracks).where(and(eq(subtitleTracks.ownerKind, owner.kind), eq(subtitleTracks.ownerId, owner.id)));
  if (n >= MAX_TRACKS_PER_TITLE) return NextResponse.json({ error: `A title can keep ${MAX_TRACKS_PER_TITLE} subtitle tracks at most.` }, { status: 409 });
  const [row] = await db.insert(subtitleTracks).values({ ownerKind: owner.kind, ownerId: owner.id, language: languageCode3(typeof body.language === "string" ? body.language : null), label, source: "saved", cues }).returning({ id: subtitleTracks.id });
  return NextResponse.json({ id: row.id }, { status: 201 });
}
