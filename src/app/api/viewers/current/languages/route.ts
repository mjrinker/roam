import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { requireActor } from "@/lib/playlists/http";
import { mediaLanguageSchema } from "@/lib/viewers/validation";

const body = z.object({ audio: mediaLanguageSchema.optional(), subtitles: mediaLanguageSchema.optional() }).strict();

/**
 * Remembers the language the signed-in profile just picked in the player (audio, and/or the subtitles; null = none), so the next video
 * that has it starts that way. Any profile may set its own (this is a viewing choice, not a restriction).
 */
export async function PUT(request: Request) {
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const changes: { audioLanguage?: string | null; subtitleLanguage?: string | null } = {};
  if (parsed.data.audio !== undefined) changes.audioLanguage = parsed.data.audio;
  if (parsed.data.subtitles !== undefined) changes.subtitleLanguage = parsed.data.subtitles;
  await db.update(viewers).set(changes).where(eq(viewers.id, who.actor.viewerId));
  return NextResponse.json({ ok: true });
}
