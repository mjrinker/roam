import { db } from "@/lib/db/client";
import { libraryVisible } from "@/lib/content/library-access";
import { libraries } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import { tvBrowseStyle } from "@/lib/libraries/profile";
import { apiJson } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import type { ApiLibrary } from "@/lib/api/v1-shapes";

/** Every library this profile can see, and how each is browsed (null: this kind of library can't be listed yet, for instance eBooks). */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/libraries">) {
  const a = await apiAccess((await ctx.params).serverId);
  if (!a.ok) return a.response;
  const rows = await db.select({ id: libraries.id, name: libraries.name, kind: libraries.kind }).from(libraries).where(libraryVisible(db, a.access.scope.actor)).orderBy(asc(libraries.name));
  const out: ApiLibrary[] = rows.map((l) => ({ ...l, style: tvBrowseStyle(l.kind) }));
  return apiJson({ libraries: out });
}
