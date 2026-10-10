/** Which of the libraries asked for can really be chosen from: ones this profile can see, and of a kind with something to watch, listen to or read. Server side. */
import { and, asc, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries } from "@/lib/db/schema";
import { isChoosableKind } from "./kinds";
import type { ChooseLibrary } from "./pick";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export async function choosableLibraries(ex: Db, actor: LibraryActor, ids?: string[]): Promise<ChooseLibrary[]> {
  const rows = await ex
    .select({ id: libraries.id, name: libraries.name, kind: libraries.kind })
    .from(libraries)
    .where(and(libraryVisible(ex, actor), ids ? inArray(libraries.id, ids) : undefined))
    .orderBy(asc(libraries.name));
  return rows.filter((l) => isChoosableKind(l.kind));
}
