import { NextResponse } from "next/server";
import { z } from "zod";
import { completeRemuxJob, failRemuxJob, getActiveJobByToken, triggerRemuxRun } from "@/lib/remux/remux-pass";

const bodySchema = z.discriminatedUnion("ok", [
  z.object({
    jobToken: z.string().min(1),
    ok: z.literal(true),
    uploaded: z.object({ id: z.string().min(1), name: z.string().optional(), size: z.number().optional() }),
  }),
  z.object({ jobToken: z.string().min(1), ok: z.literal(false), error: z.string().max(2000).optional() }),
]);

/** Internal: a sandbox reports its outcome, authenticated by its job token. A superseded token is a no-op. */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const body = parsed.data;
  const job = await getActiveJobByToken(body.jobToken);
  if (!job) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const applied = body.ok
    ? await completeRemuxJob(body.jobToken, body.uploaded)
    : await failRemuxJob(body.jobToken, body.error ?? "sandbox reported failure");

  // Work through the rest of this title's queue (one sandbox at a time).
  await triggerRemuxRun(job.titleId);
  return NextResponse.json({ applied });
}
