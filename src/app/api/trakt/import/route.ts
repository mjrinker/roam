import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { backupScope } from "@/lib/backup/http";
import { checkRateLimit } from "@/lib/rate-limit";
import { Trakt, TraktError, traktConfig } from "@/lib/trakt/client";
import { pullFromTrakt } from "@/lib/trakt/service";

/** Brings the connected Trakt account's watched history and ratings into this profile on the server in `?serverId=` (adds only, like any import). */
export async function POST(request: Request) {
  const got = await backupScope(request);
  if ("response" in got) return got.response;
  const config = traktConfig();
  if (!config) return NextResponse.json({ error: "Trakt isn't set up on this server." }, { status: 503 });
  if (!(await checkRateLimit(got.accountId, "trakt-import", 6, 3600))) return NextResponse.json({ error: "Too many imports: try again later." }, { status: 429 });
  try {
    const result = await pullFromTrakt(db, got.scope, new Trakt(config));
    if (!result) return NextResponse.json({ error: "Connect to Trakt first." }, { status: 409 });
    return NextResponse.json({ source: "Trakt", ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof TraktError ? e.message : "Trakt had a problem." }, { status: 502 });
  }
}
