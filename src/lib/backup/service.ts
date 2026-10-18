/** Building a profile's export from the database, and applying an import to it: only titles the profile may see on this server count. */
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, labelItems, labels, libraries, ratings, seasons, titles, watchlistItems, watchState } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { createLabel, listLabels, setTitleLabel } from "@/lib/labels/service";
import { emptyData, type ItemRef, type ProfileData, type TitleRef } from "./format";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface BackupScope {
  actor: LibraryActor;
  viewer: AccessProfile;
  viewerId: string;
  serverId: string;
}

const kinds = ["movie", "show"] as const;

/** The movies and shows on this server that the profile may see. */
async function visibleTitles(ex: Db, s: BackupScope) {
  return ex
    .select({ id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, tmdbId: titles.tmdbId })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(libraries.serverId, s.serverId), libraryVisible(ex, s.actor), contentFilter(s.viewer, titles.ratingAges), inArray(titles.kind, [...kinds])));
}

const titleRef = (t: { kind: string; name: string; year: number | null; tmdbId: number | null }): TitleRef => ({ kind: t.kind === "show" ? "show" : "movie", title: t.name, year: t.year, tmdbId: t.tmdbId });

/** Everything this profile has watched, rated, labelled and means to watch, among what it can see on this server. */
export async function exportProfile(ex: Db, s: BackupScope): Promise<ProfileData> {
  const all = await visibleTitles(ex, s);
  const byId = new Map(all.map((t) => [t.id, t]));
  const ids = all.map((t) => t.id);
  const data = emptyData();
  if (ids.length === 0) return data;

  const eps = await ex
    .select({ id: episodes.id, number: episodes.number, season: seasons.number, showId: seasons.titleId })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(inArray(seasons.titleId, ids));
  const epById = new Map(eps.map((e) => [e.id, e]));
  const refOf = (kind: string, id: string): ItemRef | null => {
    if (kind === "title") {
      const t = byId.get(id);
      return t ? titleRef(t) : null;
    }
    const e = epById.get(id);
    const show = e && byId.get(e.showId);
    return e && show ? { ...titleRef(show), kind: "episode", season: e.season, number: e.number } : null;
  };

  const states = await ex.select().from(watchState).where(eq(watchState.viewerId, s.viewerId));
  for (const w of states) {
    if (w.ownerKind === "extra") continue;
    const ref = refOf(w.ownerKind, w.ownerId);
    if (ref) data.watched.push({ ref, finished: w.finished, positionSeconds: w.positionSeconds, durationSeconds: w.durationSeconds, at: w.updatedAt.toISOString() });
  }
  const rated = await ex.select().from(ratings).where(eq(ratings.viewerId, s.viewerId));
  for (const r of rated) {
    if (r.ownerKind === "album") continue;
    const ref = refOf(r.ownerKind, r.ownerId);
    if (ref) data.ratings.push({ ref, halfStars: r.halfStars });
  }
  const mine = await ex.select().from(labels).where(eq(labels.viewerId, s.viewerId)).orderBy(labels.name);
  const items = mine.length ? await ex.select().from(labelItems).where(inArray(labelItems.labelId, mine.map((l) => l.id))) : [];
  for (const l of mine) data.labels.push({ name: l.name, titles: items.filter((i) => i.labelId === l.id).map((i) => byId.get(i.titleId)).filter((t): t is NonNullable<typeof t> => !!t).map(titleRef) });
  const wl = await ex.select().from(watchlistItems).where(eq(watchlistItems.viewerId, s.viewerId));
  data.watchlist = wl.map((w) => byId.get(w.titleId)).filter((t): t is NonNullable<typeof t> => !!t).map(titleRef);
  return data;
}

export interface ImportResult {
  watched: number;
  ratings: number;
  labels: number;
  watchlist: number;
  /** Things in the file that aren't on this server (or that this profile can't see): a few of them by name. */
  notFound: { total: number; sample: string[] };
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

/** Applies imported data to the profile. Never removes anything; a film already finished stays finished, and a rating you gave here is overwritten only by one in the file. */
export async function applyImport(ex: Db, s: BackupScope, data: ProfileData, now: Date = new Date()): Promise<ImportResult> {
  const all = await visibleTitles(ex, s);
  const byTmdb = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const t of all) {
    if (t.tmdbId) byTmdb.set(`${t.kind}:${t.tmdbId}`, t.id);
    const key = `${t.kind}:${norm(t.name)}`;
    byName.set(key, [...(byName.get(key) ?? []), t.id]);
  }
  const yearOf = new Map(all.map((t) => [t.id, t.year]));
  const missing = new Set<string>();
  const find = (kind: "movie" | "show", title: string, year: number | null, tmdbId: number | null): string | null => {
    if (tmdbId && byTmdb.has(`${kind}:${tmdbId}`)) return byTmdb.get(`${kind}:${tmdbId}`)!;
    const candidates = byName.get(`${kind}:${norm(title)}`) ?? [];
    const exact = year ? candidates.filter((id) => yearOf.get(id) === year) : candidates;
    // A year that is off by one (release dates differ between services) still counts when it is the only one.
    const near = exact.length ? exact : year ? candidates.filter((id) => Math.abs((yearOf.get(id) ?? 0) - year) <= 1) : [];
    if (near.length === 1 || (near.length > 1 && !year)) return near[0];
    missing.add(`${title}${year ? ` (${year})` : ""}`);
    return null;
  };

  // Episodes of the shows that matter.
  const wantShows = new Set<string>();
  const showFor = (ref: ItemRef) => find(ref.kind === "episode" ? "show" : ref.kind, ref.title, ref.year, ref.tmdbId);
  const resolved = new Map<ItemRef, string | null>();
  const allRefs: ItemRef[] = [...data.watched.map((w) => w.ref), ...data.ratings.map((r) => r.ref)];
  for (const ref of allRefs) {
    const id = ref.kind === "episode" ? showFor(ref) : find(ref.kind, ref.title, ref.year, ref.tmdbId);
    resolved.set(ref, id);
    if (id && ref.kind === "episode") wantShows.add(id);
  }
  const eps = wantShows.size
    ? await ex.select({ id: episodes.id, number: episodes.number, season: seasons.number, showId: seasons.titleId }).from(episodes).innerJoin(seasons, eq(seasons.id, episodes.seasonId)).where(inArray(seasons.titleId, [...wantShows]))
    : [];
  const epKey = new Map(eps.map((e) => [`${e.showId}:${e.season}:${e.number}`, e.id]));
  const target = (ref: ItemRef): { kind: "title" | "episode"; id: string } | null => {
    const id = resolved.get(ref);
    if (!id) return null;
    if (ref.kind !== "episode") return { kind: "title", id };
    const ep = epKey.get(`${id}:${ref.season}:${ref.number}`);
    if (!ep) {
      missing.add(`${ref.title} S${ref.season}E${ref.number}`);
      return null;
    }
    return { kind: "episode", id: ep };
  };

  const result: ImportResult = { watched: 0, ratings: 0, labels: 0, watchlist: 0, notFound: { total: 0, sample: [] } };
  for (const w of data.watched) {
    const t = target(w.ref);
    if (!t) continue;
    const at = w.at ? new Date(w.at) : now;
    await ex
      .insert(watchState)
      .values({ viewerId: s.viewerId, ownerKind: t.kind, ownerId: t.id, positionSeconds: w.finished ? 0 : w.positionSeconds, durationSeconds: w.durationSeconds, finished: w.finished, updatedAt: at })
      .onConflictDoUpdate({
        target: [watchState.viewerId, watchState.ownerKind, watchState.ownerId],
        // Never un-finish something; a saved position only replaces one on something not yet finished.
        set: w.finished ? { finished: true, positionSeconds: 0 } : { positionSeconds: w.positionSeconds, durationSeconds: w.durationSeconds, updatedAt: at },
        setWhere: w.finished ? undefined : and(eq(watchState.finished, false), eq(watchState.viewerId, s.viewerId)),
      });
    result.watched++;
  }
  for (const r of data.ratings) {
    const t = target(r.ref);
    if (!t) continue;
    await ex
      .insert(ratings)
      .values({ viewerId: s.viewerId, ownerKind: t.kind, ownerId: t.id, halfStars: r.halfStars, updatedAt: now })
      .onConflictDoUpdate({ target: [ratings.viewerId, ratings.ownerKind, ratings.ownerId], set: { halfStars: r.halfStars, updatedAt: now } });
    result.ratings++;
  }
  const mine = new Map((await listLabels(ex, s.viewerId)).map((l) => [norm(l.name), l.id]));
  for (const l of data.labels) {
    let id = mine.get(norm(l.name));
    if (!id) {
      const made = await createLabel(ex, s.viewerId, l.name);
      if (!made.ok) continue;
      id = made.value.id;
      mine.set(norm(l.name), id);
    }
    let added = 0;
    for (const t of l.titles) {
      const tid = find(t.kind, t.title, t.year, t.tmdbId);
      if (tid && (await setTitleLabel(ex, s.viewerId, id, tid, true))) added++;
    }
    if (added > 0) result.labels++;
  }
  for (const t of data.watchlist) {
    const tid = find(t.kind, t.title, t.year, t.tmdbId);
    if (!tid) continue;
    await ex.insert(watchlistItems).values({ viewerId: s.viewerId, titleId: tid }).onConflictDoNothing();
    result.watchlist++;
  }
  result.notFound = { total: missing.size, sample: [...missing].slice(0, 20) };
  return result;
}
