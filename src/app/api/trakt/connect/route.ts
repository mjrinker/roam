import { NextResponse } from "next/server";
import { requireActor } from "@/lib/playlists/http";
import { checkRateLimit } from "@/lib/rate-limit";
import { Trakt, TraktError, traktConfig } from "@/lib/trakt/client";

/** Starts connecting to Trakt: answers with a short code to type at the address given (the device flow, so nothing is typed here). */
export async function POST() {
  const who = await requireActor();
  if ("response" in who) return who.response;
  const config = traktConfig();
  if (!config) return NextResponse.json({ error: "Trakt isn't set up on this server." }, { status: 503 });
  if (!(await checkRateLimit(who.actor.accountId, "trakt-connect", 10, 3600))) return NextResponse.json({ error: "Too many tries: wait a little." }, { status: 429 });
  try {
    return NextResponse.json(await new Trakt(config).startDevice());
  } catch (e) {
    return NextResponse.json({ error: e instanceof TraktError ? e.message : "Trakt had a problem." }, { status: 502 });
  }
}
