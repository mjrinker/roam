import { timelineCursorSchema, type TimelineCursor } from "@/lib/photos/timeline";
import { listArtists } from "@/lib/music/browse";
import { db } from "@/lib/db/client";
import type { LibraryKind } from "@/lib/db/schema";
import { TV_LISTEN_KINDS } from "@/lib/libraries/profile";
import { asUuid, notFoundPage, tvAccess, type TvAccess } from "@/lib/tv/context";
import { folderCursorParam, folderLevel, libraryTitles, pageForLetter, parseFolderCursor, photoPage, tvLibrary } from "@/lib/tv/data";
import { LETTERS, nextSort, optionsQuery, parseLetter, parseLibraryOptions, SORT_WORDS, type LibraryOptions } from "@/lib/tv/library-options";
import { libraryOwnership } from "@/lib/ownership/view";
import { listCollections } from "@/lib/collections/queries";
import { html, redirectTo } from "@/lib/tv/http";
import { listPage } from "@/tv/render";

type Ok = Extract<TvAccess, { ok: true }>;

/** Folder libraries of sound (as opposed to video): their files open on the listening page. */
const isAudioFolders = (kind: LibraryKind) => TV_LISTEN_KINDS.includes(kind);

const timeParam = (c: TimelineCursor) => `${c.t ?? ""}~${c.id}`;
function parsePhotoCursor(raw: string | null): TimelineCursor | null | "bad" {
  if (!raw) return null;
  const sep = raw.lastIndexOf("~");
  const t = sep >= 0 ? raw.slice(0, sep) : "";
  const parsed = timelineCursorSchema.safeParse({ t: t === "" ? null : Number(t), id: sep >= 0 ? raw.slice(sep + 1) : "" });
  return parsed.success ? parsed.data : "bad";
}

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/library/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const library = await tvLibrary(db, access.scope, id);
  if (!library) return notFoundPage();
  const url = new URL(request.url);
  const here = `${access.base}/library/${id}`;

  switch (library.style) {
    case "grid":
      return gridPage(access, here, url, id, request);
    case "folders":
      return folderPage(access, here, url, id, isAudioFolders(library.kind));
    case "artists":
      return musicPage(access, here, url, id);
    case "timeline":
      return photosPage(access, here, url, id);
  }
}

async function gridPage(access: Ok, here: string, url: URL, id: string, request: Request) {
  const options = parseLibraryOptions(url.searchParams);
  // A letter jumps to the page it starts on (titles sorted by name).
  const letter = options.sort === "title" ? parseLetter(url.searchParams.get("letter")) : null;
  if (letter) {
    const page = await pageForLetter(db, access.scope, id, letter, options);
    return redirectTo(request, `${here}${optionsQuery(options, { page: page > 1 ? page : null })}`);
  }
  const page = Math.min(Math.max(1, Math.floor(Number(url.searchParams.get("page"))) || 1), 10_000);
  const result = await libraryTitles(db, access.scope, id, page, options);
  if (!result) return notFoundPage();
  const hrefOf = (t: { kind: string; id: string }) => `${access.base}/${t.kind === "movie" ? "title" : t.kind === "show" ? "show" : "book"}/${t.id}`;
  const households = result.ownershipOn ? ((await libraryOwnership(db, { serverId: access.serverId, libraryId: id, accountId: access.who.accountId, isAdmin: access.who.isAdmin })) ?? { households: [] }).households : [];
  const ownerWords = options.owner === "none" ? "No owner" : options.owner ? (households.find((h) => h.id === options.owner)?.name ?? "A household") : "Anyone";
  const to = (o: LibraryOptions, extra: Record<string, string | number | null> = {}) => `${here}${optionsQuery(o, extra)}`;
  const choose = (what: string) => `${here}/choose${optionsQuery(options, { what })}`;
  const narrowed = !!(options.genre || options.unwatched || options.owner);
  const collections = await listCollections(db, { actor: access.scope.actor, viewer: access.scope.viewer, libraryId: id });
  const toolbar = [
    ...(collections.length > 0 ? [{ href: `${access.base}/collections/${id}`, label: `Collections (${collections.length})` }] : []),
    { href: to({ ...options, sort: nextSort(options.sort) }), label: `Sort: ${SORT_WORDS[options.sort]}` },
    { href: choose("genre"), label: `Genre: ${options.genre ?? "Any"}` },
    { href: to({ ...options, unwatched: !options.unwatched }), label: `Unwatched only: ${options.unwatched ? "On" : "Off"}` },
    ...(result.ownershipOn ? [{ href: choose("owner"), label: `Owner: ${ownerWords}` }] : []),
    ...(narrowed ? [{ href: to({ ...options, genre: null, unwatched: false, owner: null }), label: "Clear filters" }] : []),
  ];
  return html(
    listPage({
      base: access.base,
      title: result.library.name,
      backHref: access.base,
      toolbar,
      letters: options.sort === "title" ? LETTERS.map((l) => ({ href: to(options, { letter: l }), label: l })) : undefined,
      items: result.items.map((t) => ({ href: hrefOf(t), name: t.name, meta: t.kind === "audiobook" ? (t.authors ?? []).join(", ") || null : t.year ? String(t.year) : null, posterUrl: t.posterUrl, square: t.kind === "audiobook" })),
      prevHref: page > 1 ? to(options, { page: page - 1 }) : null,
      nextHref: result.hasMore ? to(options, { page: page + 1 }) : null,
    })
  );
}

async function folderPage(access: Ok, here: string, url: URL, id: string, audio: boolean) {
  const after = parseFolderCursor(url.searchParams.get("after"));
  if (after === "bad") return notFoundPage();
  const path = url.searchParams.get("path");
  const level = await folderLevel(db, access.scope, id, path, after);
  if (!level) return notFoundPage();
  const inFolder = (p: string) => `${here}?path=${encodeURIComponent(p)}`;
  const up = level.path === "" ? access.base : level.path.includes("/") ? inFolder(level.path.slice(0, level.path.lastIndexOf("/"))) : here;
  return html(
    listPage({
      base: access.base,
      title: level.path === "" ? level.library.name : level.path.slice(level.path.lastIndexOf("/") + 1),
      subtitle: level.path === "" ? null : level.library.name,
      backHref: up,
      folders: level.folders.map((name) => ({ href: inFolder(level.path === "" ? name : `${level.path}/${name}`), name })),
      items: level.items.map((t) => ({ href: audio ? `${access.base}/listen/${t.id}` : `${access.base}/title/${t.id}`, name: t.name, meta: audio ? (t.authors ?? []).join(", ") || null : t.year ? String(t.year) : null, posterUrl: t.posterUrl, square: audio })),
      prevHref: null,
      nextHref: level.nextCursor ? `${here}?${level.path ? `path=${encodeURIComponent(level.path)}&` : ""}after=${encodeURIComponent(folderCursorParam(level.nextCursor))}` : null,
    })
  );
}

async function musicPage(access: Ok, here: string, url: URL, id: string) {
  const after = parseFolderCursor(url.searchParams.get("after"));
  if (after === "bad") return notFoundPage();
  const result = await listArtists(db, { actor: access.scope.actor, viewer: access.scope.viewer, libraryId: id, limit: 24, after });
  if (!result) return notFoundPage();
  return html(
    listPage({
      base: access.base,
      title: "Artists",
      backHref: access.base,
      items: result.items.map((a) => ({ href: `${access.base}/artist/${a.id}`, name: a.name, meta: `${a.albumCount} ${a.albumCount === 1 ? "album" : "albums"}`, posterUrl: a.coverUrls[0] ?? null, square: true })),
      prevHref: null,
      nextHref: result.next ? `${here}?after=${encodeURIComponent(folderCursorParam(result.next))}` : null,
    })
  );
}

async function photosPage(access: Ok, here: string, url: URL, id: string) {
  const view = url.searchParams.get("view");
  if (view === "albums") return albumsPage(access, here, url, id);
  const favorites = view === "favorites";
  const after = parsePhotoCursor(url.searchParams.get("after"));
  if (after === "bad") return notFoundPage();
  const result = await photoPage(db, access.scope, id, after, favorites);
  if (!result) return notFoundPage();
  const from = favorites ? "?from=favorites" : "";
  return html(
    listPage({
      base: access.base,
      title: favorites ? "Favourites" : result.library.name,
      subtitle: favorites ? result.library.name : null,
      backHref: favorites ? here : access.base,
      // The first screen offers the other ways in: pictures by folder, and the ones hearted on the web.
      actions: !after && !favorites ? [{ href: `${here}?view=albums`, name: "Albums", note: "Pictures by folder" }, { href: `${here}?view=favorites`, name: "Favourites", note: "Pictures you hearted" }] : undefined,
      items: result.items.map((p) => ({ href: p.kind === "movie" ? `${access.base}/watch/title/${p.id}${from}` : `${access.base}/photo/${p.id}${from}`, name: p.name, meta: p.takenAt ? p.takenAt.slice(0, 10) : null, posterUrl: p.posterUrl, square: true })),
      prevHref: null,
      nextHref: result.next ? `${here}?${favorites ? "view=favorites&" : ""}after=${encodeURIComponent(timeParam(result.next))}` : null,
    })
  );
}

async function albumsPage(access: Ok, here: string, url: URL, id: string) {
  const after = parseFolderCursor(url.searchParams.get("after"));
  if (after === "bad") return notFoundPage();
  const level = await folderLevel(db, access.scope, id, url.searchParams.get("path"), after, "timeline");
  if (!level) return notFoundPage();
  const albumUrl = (p: string) => `${here}?view=albums${p ? `&path=${encodeURIComponent(p)}` : ""}`;
  const up = level.path === "" ? here : albumUrl(level.path.includes("/") ? level.path.slice(0, level.path.lastIndexOf("/")) : "");
  return html(
    listPage({
      base: access.base,
      title: level.path === "" ? "Albums" : level.path.slice(level.path.lastIndexOf("/") + 1),
      subtitle: level.library.name,
      backHref: up,
      folders: level.folders.map((name) => ({ href: albumUrl(level.path === "" ? name : `${level.path}/${name}`), name, note: "Album" })),
      items: level.items.map((p) => ({ href: p.kind === "movie" ? `${access.base}/watch/title/${p.id}?from=album` : `${access.base}/photo/${p.id}?from=album`, name: p.name, meta: null, posterUrl: p.posterUrl, square: true })),
      prevHref: null,
      nextHref: level.nextCursor ? `${albumUrl(level.path)}&after=${encodeURIComponent(folderCursorParam(level.nextCursor))}` : null,
    })
  );
}
