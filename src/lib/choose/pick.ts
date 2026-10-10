/**
 * "Help me choose": random things to pick between, from the libraries someone selected. A library is picked at random first (so a small
 * library isn't drowned out by a big one), then an item in it. Everything honours the same rules as browsing: library access and the
 * profile's age limit. Server side.
 */
import { and, asc, eq, exists, notInArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { episodes, libraries, mediaFiles, musicAlbums, seasons, titles, watchState, type LibraryKind } from "@/lib/db/schema";
import { getAlbum } from "@/lib/music/browse";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** What happens when the thing chosen is played. */
export type ChooseAction =
  | { kind: "go"; href: string } // open a page (a video's player, a book's reader)
  | { kind: "listen"; titleId: string } // start an audio file in the audio player
  | { kind: "listen-list"; songIds: string[] }; // start an album

export interface ChooseItem {
  id: string;
  /** What it is, for the words on the buttons. */
  noun: "movie" | "show" | "audiobook" | "track" | "album" | "book" | "video";
  verb: "Watch" | "Listen to" | "Read";
  libraryId: string;
  libraryName: string;
  name: string;
  subtitle: string | null;
  overview: string | null;
  posterUrl: string | null;
  runtimeSeconds: number | null;
  /** Its own page, to read more about it. */
  pageHref: string;
  action: ChooseAction;
}

export interface ChooseLibrary {
  id: string;
  name: string;
  kind: LibraryKind;
}

const shorten = (text: string | null, max = 240): string | null => {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}…` : t || null;
};

/** One random title of a kind from a library, that can be played right now and isn't excluded. */
async function randomTitle(ex: Db, scope: { actor: LibraryActor; viewer: AccessProfile; library: ChooseLibrary; kind: "movie" | "show" | "audiobook" | "ebook"; exclude: string[] }) {
  const ready =
    scope.kind === "show"
      ? exists(
          ex
            .select({ one: episodes.id })
            .from(episodes)
            .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
            .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id)))
            .where(eq(seasons.titleId, titles.id))
        )
      : exists(
          ex
            .select({ one: mediaFiles.id })
            .from(mediaFiles)
            .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), scope.kind === "ebook" ? undefined : sql`${mediaFiles.durationSeconds} IS NOT NULL`))
        );
  const [row] = await ex
    .select()
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(
      and(
        eq(titles.libraryId, scope.library.id),
        eq(titles.kind, scope.kind),
        libraryVisible(ex, scope.actor),
        contentFilter(scope.viewer, titles.ratingAges),
        ready,
        scope.exclude.length > 0 ? notInArray(titles.id, scope.exclude) : undefined
      )
    )
    .orderBy(sql`random()`)
    .limit(1);
  return row?.titles ?? null;
}

/** The episode to start a show on for this profile: the first one not finished, in order, else the very first. */
async function showStartEpisode(ex: Db, showId: string, viewerId: string): Promise<string | null> {
  const [row] = await ex
    .select({ id: episodes.id })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .leftJoin(watchState, and(eq(watchState.viewerId, viewerId), eq(watchState.ownerKind, "episode"), eq(watchState.ownerId, episodes.id)))
    .where(and(eq(seasons.titleId, showId), exists(ex.select({ one: mediaFiles.id }).from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id))))))
    .orderBy(sql`coalesce(${watchState.finished}, false)`, sql`CASE WHEN ${seasons.number} = 0 THEN 1 ELSE 0 END`, asc(seasons.number), asc(episodes.number))
    .limit(1);
  return row?.id ?? null;
}

/** One random item from one library, or null when nothing in it is left to offer. */
async function pickFromLibrary(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; viewerId: string; library: ChooseLibrary; exclude: string[] }
): Promise<ChooseItem | null> {
  const { library, actor, viewer, exclude } = args;
  const base = `/s/${actor.serverId}`;
  const common = { libraryId: library.id, libraryName: library.name };

  if (library.kind === "music") {
    const [row] = await ex
      .select({ id: musicAlbums.id })
      .from(musicAlbums)
      .innerJoin(libraries, eq(libraries.id, musicAlbums.libraryId))
      .where(
        and(
          eq(musicAlbums.libraryId, library.id),
          libraryVisible(ex, actor),
          exists(ex.select({ one: titles.id }).from(titles).where(and(eq(titles.albumId, musicAlbums.id), eq(titles.kind, "audiobook"), contentFilter(viewer, titles.ratingAges)))),
          exclude.length > 0 ? notInArray(musicAlbums.id, exclude) : undefined
        )
      )
      .orderBy(sql`random()`)
      .limit(1);
    if (!row) return null;
    const page = await getAlbum(ex, { actor, viewer, albumId: row.id });
    if (!page || page.tracks.length === 0) return null;
    const { album } = page;
    return {
      id: album.id,
      noun: "album",
      verb: "Listen to",
      ...common,
      name: album.name,
      subtitle: [album.artistName, album.year].filter(Boolean).join(" · ") || null,
      overview: null,
      posterUrl: album.coverUrl,
      runtimeSeconds: page.totalSeconds || null,
      pageHref: `${base}/album/${album.id}`,
      action: { kind: "listen-list", songIds: page.tracks.map((t) => t.id) },
    };
  }

  const kind = library.kind === "shows" ? "show" : library.kind === "audiobooks" || library.kind === "audio" ? "audiobook" : library.kind === "ebooks" ? "ebook" : "movie";
  const t = await randomTitle(ex, { actor, viewer, library, kind, exclude });
  if (!t) return null;
  const authors = (t.authors?.length ? t.authors : [t.folderAuthor]).filter(Boolean).join(", ") || null;
  if (kind === "show") {
    const episodeId = await showStartEpisode(ex, t.id, args.viewerId);
    if (!episodeId) return null;
    return { id: t.id, noun: "show", verb: "Watch", ...common, name: t.name, subtitle: t.year ? String(t.year) : null, overview: shorten(t.overview), posterUrl: t.posterUrl, runtimeSeconds: null, pageHref: `${base}/show/${t.id}`, action: { kind: "go", href: `${base}/watch/episode/${episodeId}` } };
  }
  if (kind === "ebook") {
    return { id: t.id, noun: "book", verb: "Read", ...common, name: t.name, subtitle: authors, overview: shorten(t.overview), posterUrl: t.posterUrl, runtimeSeconds: null, pageHref: `${base}/ebook/${t.id}`, action: { kind: "go", href: `${base}/read/${t.id}` } };
  }
  if (kind === "audiobook") {
    const track = library.kind === "audio";
    return {
      id: t.id,
      noun: track ? "track" : "audiobook",
      verb: "Listen to",
      ...common,
      name: t.name,
      subtitle: [authors, track ? t.seriesName : null].filter(Boolean).join(" · ") || null,
      overview: shorten(t.overview),
      posterUrl: t.posterUrl,
      runtimeSeconds: t.runtimeSeconds,
      pageHref: `${base}/book/${t.id}`,
      action: { kind: "listen", titleId: t.id },
    };
  }
  return {
    id: t.id,
    noun: library.kind === "video" ? "video" : "movie",
    verb: "Watch",
    ...common,
    name: t.name,
    subtitle: t.year ? String(t.year) : null,
    overview: shorten(t.overview),
    posterUrl: t.posterUrl,
    runtimeSeconds: t.runtimeSeconds,
    pageHref: `${base}/title/${t.id}`,
    action: { kind: "go", href: `${base}/watch/title/${t.id}` },
  };
}

/**
 * Up to `count` different random items from the libraries, none of them in `exclude`. Each pick chooses a library at random among those
 * that still have something to offer. Fewer come back (or none) when the libraries run out.
 */
export async function pickRandomItems(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; viewerId: string; libraries: ChooseLibrary[]; exclude: string[]; count: number; random?: () => number }
): Promise<ChooseItem[]> {
  const random = args.random ?? Math.random;
  const out: ChooseItem[] = [];
  const exclude = [...args.exclude];
  const empty = new Set<string>();
  while (out.length < args.count) {
    const candidates = args.libraries.filter((l) => !empty.has(l.id));
    if (candidates.length === 0) break;
    const library = candidates[Math.floor(random() * candidates.length)];
    const item = await pickFromLibrary(ex, { actor: args.actor, viewer: args.viewer, viewerId: args.viewerId, library, exclude });
    if (!item) {
      empty.add(library.id);
      continue;
    }
    out.push(item);
    exclude.push(item.id);
  }
  return out;
}
