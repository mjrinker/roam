import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { libraryGenres, tvLibrary } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { optionsQuery, parseLibraryOptions } from "@/lib/tv/library-options";
import { libraryOwnership } from "@/lib/ownership/view";
import { loadSettings } from "@/lib/ownership/owners";
import { linesPage } from "@/tv/render";

/** A list to choose a genre or an owner from: each choice leads back to the library with that choice made (the rest of the options kept). */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/library/[id]/choose">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const library = await tvLibrary(db, access.scope, id);
  if (!library || library.style !== "grid") return notFoundPage();
  const url = new URL(request.url);
  const options = parseLibraryOptions(url.searchParams);
  const what = url.searchParams.get("what");
  const here = `${access.base}/library/${id}`;
  const back = `${here}${optionsQuery(options)}`;
  const go = (o: typeof options) => `${here}${optionsQuery(o)}`;

  if (what === "genre") {
    const genres = await libraryGenres(db, access.scope, id, options);
    return html(
      linesPage({
        title: "Genre",
        backHref: back,
        empty: "No genres yet.",
        lines: [{ text: "Any genre", href: go({ ...options, genre: null }) }, ...genres.map((g) => ({ text: g.name, sub: `${g.count} ${g.count === 1 ? "title" : "titles"}`, href: go({ ...options, genre: g.name }) }))],
      })
    );
  }
  if (what === "owner") {
    if (!(await loadSettings(db, serverId)).enabled) return notFoundPage();
    const view = await libraryOwnership(db, { serverId, libraryId: id, accountId: access.who.accountId, isAdmin: access.who.isAdmin });
    return html(
      linesPage({
        title: "Owner",
        backHref: back,
        empty: "Nobody owns anything here yet.",
        lines: [
          { text: "Anyone", href: go({ ...options, owner: null }) },
          { text: "No owner", sub: "Titles nobody has claimed", href: go({ ...options, owner: "none" }) },
          ...(view?.households ?? []).map((h) => ({ text: h.name, href: go({ ...options, owner: h.id }) })),
        ],
      })
    );
  }
  return notFoundPage();
}
