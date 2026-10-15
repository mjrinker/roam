import { db } from "@/lib/db/client";
import { listArtists } from "@/lib/music/browse";
import { timelineCursorSchema, type TimelineCursor } from "@/lib/photos/timeline";
import { TV_LISTEN_KINDS } from "@/lib/libraries/profile";
import { folderCursorParam, folderLevel, libraryTitles, parseFolderCursor, photoPage, tvLibrary } from "@/lib/tv/data";
import { parseLibraryOptions } from "@/lib/tv/library-options";
import { apiError, apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import type { ApiItem } from "@/lib/api/v1-shapes";

const timeParam = (c: TimelineCursor) => `${c.t ?? ""}~${c.id}`;
function parsePhotoCursor(raw: string | null): TimelineCursor | null | "bad" {
  if (!raw) return null;
  const sep = raw.lastIndexOf("~");
  const t = sep >= 0 ? raw.slice(0, sep) : "";
  const parsed = timelineCursorSchema.safeParse({ t: t === "" ? null : Number(t), id: sep >= 0 ? raw.slice(sep + 1) : "" });
  return parsed.success ? parsed.data : "bad";
}

/**
 * What is in a library, a page at a time, shaped by how it is browsed:
 *  - grid (movies, shows, audiobooks): `?page=1`; answers `{ items, hasMore }`. Optional: `sort=title|year|added`, `genre=Drama`, `unwatched=1`, `owner=<account id>|none`.
 *  - folders (video and audio folders): `?path=Some/Folder&after=CURSOR`; answers `{ path, folders, items, next }`.
 *  - artists (music): `?after=CURSOR`; answers `{ items, next }` (artists; open one for its albums).
 *  - timeline (photos): `?view=favorites|albums&after=CURSOR` (and `path` for albums); answers `{ items, next }`.
 * `next` is the value to pass as `after` for the following page, or null.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/libraries/[libraryId]/items">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const libraryId = asId(params.libraryId);
  if (!libraryId) return apiNotFound();
  const { scope } = a.access;
  const library = await tvLibrary(db, scope, libraryId);
  if (!library) return apiNotFound();
  const q = new URL(request.url).searchParams;
  const base = { library: { id: library.id, name: library.name, kind: library.kind, style: library.style } };

  if (library.style === "grid") {
    const page = Math.min(Math.max(1, Math.floor(Number(q.get("page"))) || 1), 10_000);
    const result = await libraryTitles(db, scope, libraryId, page, parseLibraryOptions(q));
    if (!result) return apiNotFound();
    const items: ApiItem[] = result.items.map((t) => ({ type: t.kind === "audiobook" ? "audiobook" : t.kind, id: t.id, name: t.name, subtitle: t.kind === "audiobook" ? (t.authors ?? []).join(", ") || null : t.year ? String(t.year) : null, posterUrl: t.posterUrl, square: t.kind === "audiobook" }));
    return apiJson({ ...base, page, hasMore: result.hasMore, items });
  }
  if (library.style === "folders") {
    const after = parseFolderCursor(q.get("after"));
    if (after === "bad") return apiError(400, "Bad cursor", "invalid_request");
    const level = await folderLevel(db, scope, libraryId, q.get("path"), after);
    if (!level) return apiNotFound();
    const audio = TV_LISTEN_KINDS.includes(library.kind);
    const items: ApiItem[] = level.items.map((t) => ({ type: audio ? "audio" : "movie", id: t.id, name: t.name, subtitle: audio ? (t.authors ?? []).join(", ") || null : t.year ? String(t.year) : null, posterUrl: t.posterUrl, square: audio }));
    return apiJson({ ...base, path: level.path, folders: level.folders, items, next: level.nextCursor ? folderCursorParam(level.nextCursor) : null });
  }
  if (library.style === "artists") {
    const after = parseFolderCursor(q.get("after"));
    if (after === "bad") return apiError(400, "Bad cursor", "invalid_request");
    const result = await listArtists(db, { actor: scope.actor, viewer: scope.viewer, libraryId, limit: 24, after });
    if (!result) return apiNotFound();
    const items: ApiItem[] = result.items.map((r) => ({ type: "artist", id: r.id, name: r.name, subtitle: `${r.albumCount} ${r.albumCount === 1 ? "album" : "albums"}`, posterUrl: r.coverUrls[0] ?? null, square: true }));
    return apiJson({ ...base, items, next: result.next ? folderCursorParam(result.next) : null });
  }
  // photos
  const view = q.get("view");
  if (view === "albums") {
    const after = parseFolderCursor(q.get("after"));
    if (after === "bad") return apiError(400, "Bad cursor", "invalid_request");
    const level = await folderLevel(db, scope, libraryId, q.get("path"), after, "timeline");
    if (!level) return apiNotFound();
    const items: ApiItem[] = level.items.map((p) => ({ type: p.kind === "movie" ? "clip" : "photo", id: p.id, name: p.name, subtitle: null, posterUrl: p.posterUrl, square: true }));
    return apiJson({ ...base, path: level.path, folders: level.folders, items, next: level.nextCursor ? folderCursorParam(level.nextCursor) : null });
  }
  const after = parsePhotoCursor(q.get("after"));
  if (after === "bad") return apiError(400, "Bad cursor", "invalid_request");
  const result = await photoPage(db, scope, libraryId, after, view === "favorites");
  if (!result) return apiNotFound();
  const items: ApiItem[] = result.items.map((p) => ({ type: p.kind === "movie" ? "clip" : "photo", id: p.id, name: p.name, subtitle: p.takenAt ? p.takenAt.slice(0, 10) : null, posterUrl: p.posterUrl, square: true }));
  return apiJson({ ...base, items, next: result.next ? timeParam(result.next) : null });
}
