import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { requireActor } from "@/lib/playlists/http";

const body = z.object({ hideScreenshots: z.boolean() }).strict();

/** Remembers whether the signed-in profile wants screenshots left out of Photos. Any profile may set its own (a viewing choice, not a restriction). */
export async function PUT(request: Request) {
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  await db.update(viewers).set({ hideScreenshots: parsed.data.hideScreenshots }).where(eq(viewers.id, who.actor.viewerId));
  return NextResponse.json({ ok: true, hideScreenshots: parsed.data.hideScreenshots });
}
