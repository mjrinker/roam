import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { requireActor } from "@/lib/playlists/http";
import { SCREENSHOT_FILTERS } from "@/lib/photos/screenshot-filter";

const body = z.object({ screenshots: z.enum(SCREENSHOT_FILTERS) }).strict();

/** Remembers how the signed-in profile wants screenshots in Photos: shown, hidden, or only them. Any profile may set its own (a viewing choice, not a restriction). */
export async function PUT(request: Request) {
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  await db.update(viewers).set({ screenshotFilter: parsed.data.screenshots }).where(eq(viewers.id, who.actor.viewerId));
  return NextResponse.json({ ok: true, screenshots: parsed.data.screenshots });
}
