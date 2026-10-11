import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { librarySources } from "@/lib/db/schema";

/** Every folder a library is made of, as stored ids: the one it was created with, then the ones added since, in the order added. */
export async function libraryRootIds(library: { id: string; boxFolderId: string }): Promise<string[]> {
  const rows = await db
    .select({ rootId: librarySources.rootId })
    .from(librarySources)
    .where(eq(librarySources.libraryId, library.id))
    .orderBy(asc(librarySources.position), asc(librarySources.createdAt), asc(librarySources.id));
  return [...new Set([library.boxFolderId, ...rows.map((r) => r.rootId)])];
}

/** What to call one of a library's added folders in a message: the name it was added under, else "(library folder)". */
export async function rootLabel(rootId: string): Promise<string> {
  const [row] = await db.select({ label: librarySources.label }).from(librarySources).where(eq(librarySources.rootId, rootId)).limit(1);
  return row?.label ?? "(library folder)";
}
