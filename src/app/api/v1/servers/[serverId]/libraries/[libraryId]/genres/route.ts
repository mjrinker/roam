import { db } from "@/lib/db/client";
import { libraryGenres, tvLibrary } from "@/lib/tv/data";
import { parseLibraryOptions } from "@/lib/tv/library-options";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";

/** The genres of a grid library with how many titles each has (within what this profile may see, and the other filters given as for the items). */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/libraries/[libraryId]/genres">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const libraryId = asId(params.libraryId);
  if (!libraryId) return apiNotFound();
  const library = await tvLibrary(db, a.access.scope, libraryId);
  if (!library || library.style !== "grid") return apiNotFound();
  return apiJson({ genres: await libraryGenres(db, a.access.scope, libraryId, parseLibraryOptions(new URL(request.url).searchParams)) });
}
