import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { requireActor } from "@/lib/playlists/http";
import { traktConfig } from "@/lib/trakt/client";
import { linkOf, unlink } from "@/lib/trakt/service";

/** Whether Trakt is set up on this server, and whether the signed-in profile is connected to it (and as whom). */
export async function GET() {
  const who = await requireActor();
  if ("response" in who) return who.response;
  const link = traktConfig() ? await linkOf(db, who.actor.viewerId) : null;
  return NextResponse.json({ configured: traktConfig() !== null, linked: link !== null, username: link?.username ?? null });
}

/** Disconnects the profile from Trakt (nothing already sent there is touched). */
export async function DELETE() {
  const who = await requireActor();
  if ("response" in who) return who.response;
  await unlink(db, who.actor.viewerId);
  return NextResponse.json({ ok: true });
}
