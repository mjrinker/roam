import { after, NextResponse } from "next/server";
import { z } from "zod";
import { triggerRemuxRun } from "@/lib/remux/remux-pass";
import { runNextRemuxJob } from "@/lib/remux/runner";

// A Tier 1 job (download + ffmpeg + upload of a small file) runs entirely
// inside this invocation; needs Fluid Compute (see vercel.json) for the
// longer limit.
export const maxDuration = 300;

const bodySchema = z.object({ titleId: z.string().uuid() });

/** Internal: works one pending remux job for a title, then chains the next. Authenticated with CRON_SECRET, like /api/scan/continue. */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { titleId } = parsed.data;

  after(async () => {
    try {
      const outcome = await runNextRemuxJob(titleId);
      if (outcome.claimed && outcome.chain) await triggerRemuxRun(titleId);
    } catch (err) {
      console.error(`Remux run failed for title ${titleId}:`, err);
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
