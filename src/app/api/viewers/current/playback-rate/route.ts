import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from "@/lib/player/timeline";

const bodySchema = z.object({ rate: z.number().min(MIN_PLAYBACK_RATE).max(MAX_PLAYBACK_RATE) });

/** Saves the selected profile's audiobook playback speed so it follows them across devices. */
export async function PATCH(request: Request) {
  const resolved = await getCurrentViewer();
  if (!resolved) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!resolved.viewer) return NextResponse.json({ error: "viewer_required" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  await db.update(viewers).set({ playbackRate: parsed.data.rate }).where(eq(viewers.id, resolved.viewer.id));
  return NextResponse.json({ ok: true });
}
