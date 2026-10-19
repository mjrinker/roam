import { NextResponse } from "next/server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { applyPhotoEdits, parsePhotoEdits } from "@/lib/backup/photo-edits";
import { checkRateLimit } from "@/lib/rate-limit";

export const maxDuration = 120;
const MAX_BYTES = 24 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Brings a photo file back (`?serverId=`; the body is the file's text): names, tags, dismissed faces, and dates and places set by hand.
 * Admin only. Adds and overwrites what the file says and never removes anything else; answers with what was applied, what couldn't be found,
 * and how many tags are waiting for their faces to be found (run scripts/scan-faces.ts, then bring the file in again).
 */
export async function POST(request: Request) {
  const serverId = new URL(request.url).searchParams.get("serverId") ?? "";
  const admin = UUID.test(serverId) ? await getCurrentServerAdmin(serverId) : null;
  if (!admin) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await checkRateLimit(admin.profile.id, "photo-import", 6, 3600))) return NextResponse.json({ error: "Too many imports: try again later." }, { status: 429 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return NextResponse.json({ error: "That file is too large (24 MB at most)." }, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BYTES) return NextResponse.json({ error: "That file is too large (24 MB at most)." }, { status: 413 });
  const parsed = parsePhotoEdits(text);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return NextResponse.json(await applyPhotoEdits(db, serverId, parsed.edits));
}
