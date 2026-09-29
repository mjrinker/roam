import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveJobByToken } from "@/lib/remux/remux-pass";
import { mintUploadToken } from "@/lib/storage/box";

const bodySchema = z.object({ jobToken: z.string().min(1) });

/**
 * Internal: a sandbox asks for a fresh upload token, authenticated by its
 * own job's random token (never CRON_SECRET, so a compromised sandbox can do
 * no more than upload into its one folder). The token is only honored while
 * that job is still the live in_progress attempt.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const job = await getActiveJobByToken(parsed.data.jobToken);
  if (!job) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { accessToken, expiresAt } = await mintUploadToken(job.serverId, job.folderId);
    return NextResponse.json({ accessToken, expiresAt: expiresAt.toISOString(), folderId: job.folderId });
  } catch (err) {
    console.error("Couldn't mint a remux upload token:", err);
    return NextResponse.json({ error: "Couldn't mint an upload token" }, { status: 502 });
  }
}
