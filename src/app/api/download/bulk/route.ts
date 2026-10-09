import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { bulkDownloadOptions, MAX_BULK_TITLES } from "@/lib/offline/bulk";
import { checkRateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({ titleIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_TITLES) });

/**
 * The download choices for a selection of titles (movies, shows, audiobooks), each checked against the same gate as playing it. A show
 * stands for all its episodes. Anything not allowed is simply counted in `skipped`.
 */
export async function POST(request: Request) {
  const resolved = await getCurrentViewer();
  if (!resolved?.viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send titleIds: a list of up to 300 title ids." }, { status: 400 });
  if (!(await checkRateLimit(resolved.account.id, "download_bulk", 20, 60))) return NextResponse.json({ error: "Too many requests: try again in a minute." }, { status: 429 });
  return NextResponse.json(await bulkDownloadOptions(parsed.data.titleIds), { headers: { "Cache-Control": "no-store" } });
}
