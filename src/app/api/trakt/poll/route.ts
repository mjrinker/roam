import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { requireActor } from "@/lib/playlists/http";
import { Trakt, TraktError, traktConfig } from "@/lib/trakt/client";
import { saveLink } from "@/lib/trakt/service";

const body = z.object({ deviceCode: z.string().min(8).max(200) }).strict();

/** Checks whether the code from /connect has been approved: `{ status: "pending" | "linked" | "expired" }` (and the Trakt username once linked). */
export async function POST(request: Request) {
  const who = await requireActor();
  if ("response" in who) return who.response;
  const config = traktConfig();
  if (!config) return NextResponse.json({ error: "Trakt isn't set up on this server." }, { status: 503 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const client = new Trakt(config);
  try {
    const answer = await client.pollDevice(parsed.data.deviceCode);
    if (answer === "pending" || answer === "expired") return NextResponse.json({ status: answer });
    const username = await client.username(answer.accessToken);
    await saveLink(db, who.actor.viewerId, answer, username);
    return NextResponse.json({ status: "linked", username });
  } catch (e) {
    return NextResponse.json({ error: e instanceof TraktError ? e.message : "Trakt had a problem." }, { status: 502 });
  }
}
