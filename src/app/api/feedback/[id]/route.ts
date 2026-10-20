import { NextResponse } from "next/server";
import { z } from "zod";
import { afterResponse } from "@/lib/after-response";
import { db } from "@/lib/db/client";
import { githubConfig } from "@/lib/feedback/github";
import { feedbackActor, isId, noStore, notFound, signedOut } from "@/lib/feedback/http";
import { deleteItem, getItem, syncGithub, triage } from "@/lib/feedback/service";

/** One item with its comments: if it is public, or yours, or you are the platform admin (who also sees the author and the technical details). */
export async function GET(_request: Request, ctx: RouteContext<"/api/feedback/[id]">) {
  const actor = await feedbackActor();
  if (!actor) return signedOut();
  const { id } = await ctx.params;
  const found = isId(id) ? await getItem(db, actor.who, id) : null;
  return found ? NextResponse.json(found, { headers: noStore }) : notFound();
}

const triageSchema = z.object({ status: z.string().optional(), visibility: z.string().optional(), duplicateOf: z.string().nullable().optional() }).strict();

/** Platform admin: set an item's status or visibility, or mark it a duplicate. A GitHub issue follows (closed for done, declined and duplicate). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/feedback/[id]">) {
  const actor = await feedbackActor();
  if (!actor?.who.operator) return notFound();
  const { id } = await ctx.params;
  const body = triageSchema.safeParse(await request.json().catch(() => null));
  if (!isId(id) || !body.success) return NextResponse.json({ error: "That didn't look right." }, { status: 400, headers: noStore });
  const result = await triage(db, id, body.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: noStore });
  const cfg = githubConfig();
  if (cfg) afterResponse(() => syncGithub(db, id, cfg));
  return NextResponse.json({ ok: true, status: result.value.status }, { headers: noStore });
}

/** Platform admin: remove an item (spam, say) with its votes and comments. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/feedback/[id]">) {
  const actor = await feedbackActor();
  if (!actor?.who.operator) return notFound();
  const { id } = await ctx.params;
  return isId(id) && (await deleteItem(db, id)) ? NextResponse.json({ ok: true }, { headers: noStore }) : notFound();
}
