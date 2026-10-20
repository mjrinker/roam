import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { feedbackActor, isId, noStore, notFound } from "@/lib/feedback/http";
import { deleteComment } from "@/lib/feedback/service";

/** Platform admin: remove a comment. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/feedback/[id]/comments/[commentId]">) {
  const actor = await feedbackActor();
  if (!actor?.who.operator) return notFound();
  const { id, commentId } = await ctx.params;
  return isId(id) && isId(commentId) && (await deleteComment(db, id, commentId)) ? NextResponse.json({ ok: true }, { headers: noStore }) : notFound();
}
