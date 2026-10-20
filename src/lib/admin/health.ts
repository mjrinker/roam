/**
 * What on a server needs the admin's attention: storage that has to be signed in again, libraries never scanned or whose last scan had
 * errors, movies and shows with nothing to play, files that couldn't be read, titles still to be matched, and what looks like the same
 * title twice. Read-only: it only looks, and the settings page says where to fix each.
 */
import { splitScanMessages } from "@/lib/scan/notices";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, mediaFiles, scanRuns, storageConnections, titles } from "@/lib/db/schema";
import { hasPlayableFile } from "@/lib/content/playable";
import { libraryKindUsesExternalMetadata } from "@/lib/libraries/profile";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** A library not scanned for this long is flagged. */
export const STALE_SCAN_DAYS = 14;
const SAMPLE = 25;

export interface TitleRef {
  id: string;
  name: string;
  year: number | null;
  kind: string;
  libraryName: string;
}

export interface ServerHealth {
  /** Storage that needs signing in again (or never was). */
  connections: { id: string; label: string; status: string }[];
  libraries: { id: string; name: string; problem: "never_scanned" | "scan_errors" | "stale"; detail: string }[];
  /** Movies and shows with no file to play: how many, and the first few. */
  noFile: { total: number; sample: TitleRef[] };
  /** Files Roam tried to read and couldn't. */
  unreadable: { total: number; sample: { id: string; filename: string; libraryName: string | null }[] };
  unmatched: number;
  /** The same name and year more than once in a library. */
  duplicates: { name: string; year: number | null; libraryName: string; count: number; ids: string[] }[];
}

export const healthIssueCount = (h: ServerHealth): number =>
  h.connections.length + h.libraries.length + (h.noFile.total > 0 ? 1 : 0) + (h.unreadable.total > 0 ? 1 : 0) + (h.unmatched > 0 ? 1 : 0) + h.duplicates.length;

export async function serverHealth(ex: Db, serverId: string, now: Date = new Date()): Promise<ServerHealth> {
  const connections = (await ex.select({ id: storageConnections.id, label: storageConnections.label, status: storageConnections.authStatus }).from(storageConnections).where(eq(storageConnections.serverId, serverId))).filter((c) => c.status !== "connected");

  const libs = await ex.select({ id: libraries.id, name: libraries.name, kind: libraries.kind, lastScannedAt: libraries.lastScannedAt }).from(libraries).where(eq(libraries.serverId, serverId));
  const libIds = libs.map((l) => l.id);
  const libName = new Map(libs.map((l) => [l.id, l.name]));

  // The latest scan of each library, for its errors.
  const lastScans = libIds.length ? await ex.selectDistinctOn([scanRuns.libraryId], { libraryId: scanRuns.libraryId, errors: scanRuns.errors }).from(scanRuns).where(inArray(scanRuns.libraryId, libIds)).orderBy(scanRuns.libraryId, desc(scanRuns.startedAt)) : [];
  const errorsOf = new Map(lastScans.map((s) => [s.libraryId, splitScanMessages(s.errors ?? []).errors]));
  const libraryProblems: ServerHealth["libraries"] = [];
  for (const l of libs) {
    const errors = errorsOf.get(l.id) ?? [];
    if (!l.lastScannedAt) libraryProblems.push({ id: l.id, name: l.name, problem: "never_scanned", detail: "Never scanned" });
    else if (errors.length > 0) libraryProblems.push({ id: l.id, name: l.name, problem: "scan_errors", detail: `${errors.length} error${errors.length === 1 ? "" : "s"} in the last scan` });
    else if (now.getTime() - l.lastScannedAt.getTime() > STALE_SCAN_DAYS * 86_400_000) libraryProblems.push({ id: l.id, name: l.name, problem: "stale", detail: `Not scanned for over ${STALE_SCAN_DAYS} days` });
  }

  const videoLibIds = libs.filter((l) => l.kind === "movies" || l.kind === "shows").map((l) => l.id);
  const noFileWhere = and(inArray(titles.libraryId, videoLibIds.length ? videoLibIds : [serverId]), inArray(titles.kind, ["movie", "show"]), sql`NOT ${hasPlayableFile(titles.id, titles.kind)}`);
  const [{ total: noFileTotal }] = await ex.select({ total: sql<number>`count(*)::int` }).from(titles).where(noFileWhere);
  const noFileSample = await ex.select({ id: titles.id, name: titles.name, year: titles.year, kind: titles.kind, libraryId: titles.libraryId }).from(titles).where(noFileWhere).orderBy(titles.name).limit(SAMPLE);

  const scopedFiles = sql`(
    (${mediaFiles.ownerKind} = 'title' AND EXISTS (SELECT 1 FROM titles t WHERE t.id = ${mediaFiles.ownerId} AND t.library_id = ANY(${sql.raw(libIds.length ? `ARRAY[${libIds.map((i) => `'${i}'::uuid`).join(",")}]` : "ARRAY[]::uuid[]")})))
    OR (${mediaFiles.ownerKind} = 'episode' AND EXISTS (SELECT 1 FROM episodes e JOIN seasons s ON s.id = e.season_id JOIN titles t ON t.id = s.title_id WHERE e.id = ${mediaFiles.ownerId} AND t.library_id = ANY(${sql.raw(libIds.length ? `ARRAY[${libIds.map((i) => `'${i}'::uuid`).join(",")}]` : "ARRAY[]::uuid[]")}))))`;
  const [{ total: badTotal }] = await ex.select({ total: sql<number>`count(*)::int` }).from(mediaFiles).where(and(eq(mediaFiles.probeStatus, "failed"), scopedFiles));
  const badSample = await ex.select({ id: mediaFiles.id, filename: mediaFiles.filename }).from(mediaFiles).where(and(eq(mediaFiles.probeStatus, "failed"), scopedFiles)).limit(SAMPLE);

  const matchable = libs.filter((l) => libraryKindUsesExternalMetadata(l.kind)).map((l) => l.id);
  const [{ total: unmatched }] = matchable.length ? await ex.select({ total: sql<number>`count(*)::int` }).from(titles).where(and(inArray(titles.libraryId, matchable), inArray(titles.metadataStatus, ["pending", "not_found"]))) : [{ total: 0 }];

  const dupes = videoLibIds.length
    ? await ex
        .select({ libraryId: titles.libraryId, name: sql<string>`min(${titles.name})`, year: titles.year, count: sql<number>`count(*)::int`, ids: sql<string[]>`array_agg(${titles.id})` })
        .from(titles)
        .where(and(inArray(titles.libraryId, videoLibIds), inArray(titles.kind, ["movie", "show"])))
        .groupBy(titles.libraryId, sql`lower(${titles.name})`, titles.year)
        .having(sql`count(*) > 1`)
        .limit(SAMPLE)
    : [];

  return {
    connections,
    libraries: libraryProblems,
    noFile: { total: noFileTotal, sample: noFileSample.map((t) => ({ id: t.id, name: t.name, year: t.year, kind: t.kind, libraryName: libName.get(t.libraryId) ?? "" })) },
    unreadable: { total: badTotal, sample: badSample.map((f) => ({ id: f.id, filename: f.filename, libraryName: null })) },
    unmatched,
    duplicates: dupes.map((d) => ({ name: d.name, year: d.year, libraryName: libName.get(d.libraryId) ?? "", count: d.count, ids: d.ids })),
  };
}
