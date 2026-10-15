import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { adminOfLibrary, json } from "@/lib/collections/http";
import { cleanName, createCollection, manualCollections } from "@/lib/collections/service";
import { readJson, uuid } from "@/lib/ownership/http";

/** The hand-made collections of a library, and whether the given title is in each (for the "Add to collection" menu). Admin only. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const libraryId = q.get("libraryId") ?? "";
  const admin = await adminOfLibrary(libraryId);
  if (admin instanceof NextResponse) return admin;
  const titleId = uuid.safeParse(q.get("titleId")).success ? (q.get("titleId") as string) : null;
  return json({ collections: await manualCollections(db, libraryId, titleId) });
}

const body = z.object({ libraryId: uuid, name: z.string() }).strict();

/** The server's admin makes a collection in a library (movies, shows or audiobooks). */
export async function POST(request: Request) {
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const admin = await adminOfLibrary(data.libraryId);
  if (admin instanceof NextResponse) return admin;
  const name = cleanName(data.name);
  if (!name) return json({ error: "Give the collection a name (up to 80 characters)." }, 400);
  const made = await createCollection(db, { libraryId: data.libraryId, name });
  if (made === "taken") return json({ error: "There's already a collection with that name here." }, 409);
  return json({ id: made.id });
}
