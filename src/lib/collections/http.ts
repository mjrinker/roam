import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { collections, libraries } from "@/lib/db/schema";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { json, notFound, uuid } from "@/lib/ownership/http";
import type { NextResponse } from "next/server";

/** The server's admin (not a limited profile), for the library or collection named: anyone else, and anything that isn't there, gets "not found". */
export async function adminOfLibrary(libraryId: string): Promise<{ serverId: string } | NextResponse> {
  if (!uuid.safeParse(libraryId).success) return notFound();
  const [lib] = await db.select({ serverId: libraries.serverId, kind: libraries.kind }).from(libraries).where(eq(libraries.id, libraryId)).limit(1);
  if (!lib || !["movies", "shows", "audiobooks"].includes(lib.kind)) return notFound();
  return (await getCurrentServerAdmin(lib.serverId)) ? { serverId: lib.serverId } : notFound();
}

export async function adminOfCollection(collectionId: string): Promise<{ serverId: string; libraryId: string } | NextResponse> {
  if (!uuid.safeParse(collectionId).success) return notFound();
  const [row] = await db
    .select({ serverId: libraries.serverId, libraryId: libraries.id })
    .from(collections)
    .innerJoin(libraries, eq(libraries.id, collections.libraryId))
    .where(eq(collections.id, collectionId))
    .limit(1);
  if (!row) return notFound();
  return (await getCurrentServerAdmin(row.serverId)) ? row : notFound();
}

export { json };
