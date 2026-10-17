import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { badRequest, isUuid, notFound, readJson, requireActor, throttled, uuid } from "@/lib/playlists/http";
import { setTitleLabel } from "@/lib/labels/service";
import { LABEL_TITLE_KINDS } from "@/lib/labels/kinds";

const body = z.object({ titleId: uuid, on: z.boolean() }).strict();

/** Puts a movie, show or book under one of the profile's labels (`on: true`) or takes it off. The title must be one the profile can see. */
export async function PUT(request: Request, ctx: RouteContext<"/api/labels/[id]/items">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const limited = await throttled(who.actor.accountId, "labels", 300, 600);
  if (limited) return limited;
  const parsed = body.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  const auth = await authorizeOwner("title", parsed.data.titleId, { titleKinds: [...LABEL_TITLE_KINDS] });
  if (!auth.ok || auth.member.viewer.id !== who.actor.viewerId) return notFound();
  return (await setTitleLabel(db, who.actor.viewerId, id, parsed.data.titleId, parsed.data.on)) ? NextResponse.json({ ok: true, on: parsed.data.on }) : notFound();
}
