import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { adminOfCollection, json } from "@/lib/collections/http";
import { cleanName, deleteCollection, renameCollection } from "@/lib/collections/service";
import { notFound, readJson } from "@/lib/ownership/http";

const body = z.object({ name: z.string() }).strict();

/** Renames a hand-made collection (a film series keeps TMDB's name). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/collections/[id]">) {
  const { id } = await ctx.params;
  const admin = await adminOfCollection(id);
  if (admin instanceof NextResponse) return admin;
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const name = cleanName(data.name);
  if (!name) return json({ error: "Give the collection a name (up to 80 characters)." }, 400);
  const result = await renameCollection(db, id, name);
  if (result === "not_found") return notFound();
  if (result === "taken") return json({ error: "There's already a collection with that name here." }, 409);
  return json({ ok: true });
}

/** Deletes a hand-made collection (what was in it stays in the library). */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/collections/[id]">) {
  const { id } = await ctx.params;
  const admin = await adminOfCollection(id);
  if (admin instanceof NextResponse) return admin;
  return (await deleteCollection(db, id)) ? json({ ok: true }) : notFound();
}
