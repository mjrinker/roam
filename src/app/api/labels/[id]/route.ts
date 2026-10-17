import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { badRequest, isUuid, notFound, readJson, requireActor, throttled } from "@/lib/playlists/http";
import { deleteLabel, renameLabel } from "@/lib/labels/service";

const body = z.object({ name: z.string().max(200) }).strict();

/** Renames one of the profile's labels. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/labels/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const limited = await throttled(who.actor.accountId, "labels", 60, 600);
  if (limited) return limited;
  const parsed = body.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  const done = await renameLabel(db, who.actor.viewerId, id, parsed.data.name);
  return done.ok ? NextResponse.json(done.value) : NextResponse.json({ error: done.error }, { status: done.status });
}

/** Deletes one of the profile's labels (whatever was under it is untouched). */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/labels/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  return (await deleteLabel(db, who.actor.viewerId, id)) ? NextResponse.json({ ok: true }) : notFound();
}
