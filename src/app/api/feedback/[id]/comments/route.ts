import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { feedbackActor, forbidden, isId, noStore, notFound, signedOut } from "@/lib/feedback/http";
import { MAX_COMMENTS_PER_DAY } from "@/lib/feedback/rules";
import { addComment } from "@/lib/feedback/service";
import { checkRateLimit } from "@/lib/rate-limit";

/** Add a comment to a public item, or to your own; the platform admin's are shown as "Roam team". */
export async function POST(request: Request, ctx: RouteContext<"/api/feedback/[id]/comments">) {
  const actor = await feedbackActor();
  if (!actor) return signedOut();
  if (!actor.canWrite) return forbidden();
  const { id } = await ctx.params;
  const body = z.object({ body: z.string().max(10_000) }).safeParse(await request.json().catch(() => null));
  if (!isId(id) || !body.success) return notFound();
  if (!(await checkRateLimit(actor.who.accountId, "feedback_comment", MAX_COMMENTS_PER_DAY, 86_400))) return NextResponse.json({ error: "That's a lot of comments for one day." }, { status: 429, headers: noStore });
  const result = await addComment(db, actor.who, id, body.data.body);
  return result.ok ? NextResponse.json(result.value, { status: 201, headers: noStore }) : NextResponse.json({ error: result.error }, { status: result.status, headers: noStore });
}
