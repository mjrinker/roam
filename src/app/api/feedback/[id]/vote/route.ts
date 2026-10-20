import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { feedbackActor, forbidden, isId, noStore, notFound, signedOut } from "@/lib/feedback/http";
import { setVote } from "@/lib/feedback/service";

async function vote(ctx: RouteContext<"/api/feedback/[id]/vote">, on: boolean) {
  const actor = await feedbackActor();
  if (!actor) return signedOut();
  if (!actor.canWrite) return forbidden();
  const { id } = await ctx.params;
  const result = isId(id) ? await setVote(db, actor.who, id, on) : null;
  return result?.ok ? NextResponse.json(result.value, { headers: noStore }) : notFound();
}

/** Vote for a public item (one vote each; saying it again changes nothing). */
export const PUT = (_request: Request, ctx: RouteContext<"/api/feedback/[id]/vote">) => vote(ctx, true);
/** Take the vote back. */
export const DELETE = (_request: Request, ctx: RouteContext<"/api/feedback/[id]/vote">) => vote(ctx, false);
