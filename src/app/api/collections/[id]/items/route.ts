import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { adminOfCollection, json } from "@/lib/collections/http";
import { addToCollection, removeFromCollection } from "@/lib/collections/service";
import { notFound, readJson, uuid } from "@/lib/ownership/http";

const add = z.object({ titleIds: z.array(uuid).min(1).max(500) }).strict();
const remove = z.object({ titleId: uuid }).strict();

/** Puts titles of the collection's library into a hand-made collection. */
export async function PUT(request: Request, ctx: RouteContext<"/api/collections/[id]/items">) {
  const { id } = await ctx.params;
  const admin = await adminOfCollection(id);
  if (admin instanceof NextResponse) return admin;
  const data = await readJson(request, add);
  if (data instanceof NextResponse) return data;
  const added = await addToCollection(db, id, data.titleIds);
  return added === null ? notFound() : json({ added });
}

/** Takes one title out of a hand-made collection. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/collections/[id]/items">) {
  const { id } = await ctx.params;
  const admin = await adminOfCollection(id);
  if (admin instanceof NextResponse) return admin;
  const data = await readJson(request, remove);
  if (data instanceof NextResponse) return data;
  return (await removeFromCollection(db, id, data.titleId)) ? json({ ok: true }) : notFound();
}
