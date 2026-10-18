import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { backupScope } from "@/lib/backup/http";
import { parseImport } from "@/lib/backup/format";
import { applyImport } from "@/lib/backup/service";

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Brings a file into the signed-in profile (`?serverId=`; the body is the file's text): a Roam export, a Letterboxd watched.csv or ratings.csv,
 * or a plain CSV. Adds to what is there and never removes anything; answers with what was applied and what couldn't be found on this server.
 */
export async function POST(request: Request) {
  const got = await backupScope(request);
  if ("response" in got) return got.response;
  if (!(await checkRateLimit(got.accountId, "profile-import", 10, 3600))) return NextResponse.json({ error: "Too many imports: try again later." }, { status: 429 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return NextResponse.json({ error: "That file is too large (8 MB at most)." }, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BYTES) return NextResponse.json({ error: "That file is too large (8 MB at most)." }, { status: 413 });
  const parsed = parseImport(text);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const result = await applyImport(db, got.scope, parsed.data);
  return NextResponse.json({ source: parsed.source, ...result });
}
