import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentProfile } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";
import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from "@/lib/player/timeline";

const bodySchema = z.object({ rate: z.number().min(MIN_PLAYBACK_RATE).max(MAX_PLAYBACK_RATE) });

/** Saves the signed-in user's audiobook playback speed so it follows them across devices. */
export async function PATCH(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  await db.update(profiles).set({ playbackRate: parsed.data.rate }).where(eq(profiles.id, profile.id));
  return NextResponse.json({ ok: true });
}
