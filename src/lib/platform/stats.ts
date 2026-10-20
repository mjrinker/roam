/** The numbers and problems on the platform admin page, for every server at once. Read-only. */
import { splitScanMessages } from "@/lib/scan/notices";
import { and, count, countDistinct, desc, eq, gt, isNotNull, isNull, lt, min, ne, sql, sum } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  episodes,
  libraries,
  mediaFiles,
  invites,
  platformJobs,
  profiles,
  providerAccounts,
  scanRuns,
  seasons,
  serverMembers,
  servers,
  storageConnections,
  titles,
  tmdbEntries,
  viewers,
  watchState,
  type StorageProviderKind,
} from "@/lib/db/schema";
import { FRESH_MS } from "@/lib/tmdb/cache";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const DAY = 86_400_000;

/** Runs the queries one after another (each is a function that starts it), keeping their order and types. */
async function series<T extends (() => Promise<unknown>)[]>(...fns: T): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const fn of fns) out.push(await fn());
  return out as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/** How many accounts an unapproved app may link, where a provider says (Dropbox: 50 for a development app; Google: 100 while unverified). */
export const PROVIDER_ACCOUNT_CAPS: Partial<Record<StorageProviderKind, number>> = { dropbox: 50, gdrive: 100 };
/** The point at which the page starts warning. */
export const CAP_WARN_FRACTION = 0.8;

export interface ProviderUsage {
  provider: StorageProviderKind;
  cap: number | null;
  /** Accounts linked to Roam now (never unlinked). */
  linked: number;
  /** Accounts ever linked, including those since unlinked. */
  everLinked: number;
  accounts: { label: string; revoked: boolean; firstConnectedAt: Date; servers: string[] }[];
  /** "ok", "warn" (80% of the cap or more) or "full" (at or over it); "none" when the provider has no cap. */
  status: "none" | "ok" | "warn" | "full";
}

export interface PlatformStats {
  totals: { accounts: number; guests: number; servers: number; libraries: number; titles: number; episodes: number; files: number; pendingInvites: number };
  librariesByKind: Record<string, number>;
  connections: { provider: StorageProviderKind; total: number; connected: number; needsReauth: number; disconnected: number }[];
  providers: ProviderUsage[];
  activity: { newAccounts7: number; newAccounts30: number; active7: number; active30: number };
  health: {
    needsReauth: { serverName: string; label: string; provider: StorageProviderKind }[];
    scanErrors: { serverName: string; libraryName: string; errors: number; first: string; finishedAt: Date | null }[];
    neverScanned: { serverName: string; libraryName: string }[];
    probes: { pending: number; failed: number };
    tmdb: { entries: number; due: number; oldestDays: number | null; lastRun: { at: Date; summary: Record<string, unknown> | null } | null };
  };
  /** Per library type: how much is in it. Files are the main files only (not extras or other versions). */
  itemsByKind: { kind: string; libraries: number; items: number; episodes: number; files: number; bytes: number }[];
  servers: { id: string; name: string; owner: string; members: number; libraries: number; titles: number; connections: number; createdAt: Date; dddAccess: "disabled" | "limited" | "full" }[];
}

export function usageStatus(linked: number, cap: number | null): ProviderUsage["status"] {
  if (cap === null) return "none";
  if (linked >= cap) return "full";
  return linked >= cap * CAP_WARN_FRACTION ? "warn" : "ok";
}

export async function loadPlatformStats(ex: Db, now: Date = new Date()): Promise<PlatformStats> {
  const since = (days: number) => new Date(now.getTime() - days * DAY);
  // The app has ONE database connection, and several queries in flight at once on it never finish: ask in turn (series), never together.
  const one = <T>(q: PromiseLike<T[]>) => async (): Promise<T> => (await q)[0];

  const [accounts, guests, serverCount, libCount, titleCount, episodeCount, fileCount, inviteCount] = await series(
    one(ex.select({ n: count() }).from(profiles).where(eq(profiles.isGuest, false))),
    one(ex.select({ n: count() }).from(profiles).where(eq(profiles.isGuest, true))),
    one(ex.select({ n: count() }).from(servers)),
    one(ex.select({ n: count() }).from(libraries)),
    one(ex.select({ n: count() }).from(titles)),
    one(ex.select({ n: count() }).from(episodes)),
    one(ex.select({ n: count() }).from(mediaFiles).where(and(isNull(mediaFiles.variantOfMediaFileId), isNotNull(mediaFiles.ownerKind)))),
    one(ex.select({ n: count() }).from(invites).where(and(isNull(invites.acceptedAt), gt(invites.expiresAt, now)))),
  );

  const kinds = await ex.select({ kind: libraries.kind, n: count() }).from(libraries).groupBy(libraries.kind);
  const librariesByKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]));

  const connRows = await ex.select({ provider: storageConnections.provider, status: storageConnections.authStatus, n: count() }).from(storageConnections).groupBy(storageConnections.provider, storageConnections.authStatus);
  const connections = [...new Set(connRows.map((r) => r.provider))].sort().map((provider) => {
    const of = (s: string) => connRows.filter((r) => r.provider === provider && r.status === s).reduce((a, r) => a + r.n, 0);
    return { provider, connected: of("connected"), needsReauth: of("needs_reauth"), disconnected: of("disconnected"), total: connRows.filter((r) => r.provider === provider).reduce((a, r) => a + r.n, 0) };
  });

  // Linked outside accounts, with where each is used.
  const ledger = await ex.select().from(providerAccounts).orderBy(providerAccounts.provider, providerAccounts.firstConnectedAt);
  const uses = await ex
    .select({ provider: storageConnections.provider, account: sql<string>`lower(${storageConnections.accountName})`, serverName: servers.name })
    .from(storageConnections)
    .innerJoin(servers, eq(storageConnections.serverId, servers.id))
    .where(isNotNull(storageConnections.accountName));
  const providerList = [...new Set<StorageProviderKind>([...Object.keys(PROVIDER_ACCOUNT_CAPS) as StorageProviderKind[], ...ledger.map((l) => l.provider)])];
  const providers: ProviderUsage[] = providerList.map((provider) => {
    const rows = ledger.filter((l) => l.provider === provider);
    const linked = rows.filter((r) => !r.revokedAt).length;
    const cap = PROVIDER_ACCOUNT_CAPS[provider] ?? null;
    return {
      provider,
      cap,
      linked,
      everLinked: rows.length,
      status: usageStatus(linked, cap),
      accounts: rows.map((r) => ({ label: r.label, revoked: !!r.revokedAt, firstConnectedAt: r.firstConnectedAt, servers: [...new Set(uses.filter((u) => u.provider === provider && u.account === r.accountKey).map((u) => u.serverName))] })),
    };
  });

  // Box has no account limit and isn't in the ledger (nothing is unlinked there): its accounts are read from the connections as they are now.
  const boxRows = await ex
    .select({ label: storageConnections.label, account: storageConnections.accountName, createdAt: storageConnections.createdAt, serverName: servers.name })
    .from(storageConnections)
    .innerJoin(servers, eq(storageConnections.serverId, servers.id))
    .where(eq(storageConnections.provider, "box"))
    .orderBy(storageConnections.createdAt);
  if (boxRows.length > 0) {
    const byAccount = new Map<string, { label: string; firstConnectedAt: Date; servers: Set<string> }>();
    boxRows.forEach((r, i) => {
      // A connection that never reported who it is counts as its own account, so the number never understates.
      const key = r.account ? r.account.trim().toLowerCase() : `unnamed:${i}`;
      const entry = byAccount.get(key) ?? { label: r.account?.trim() || `${r.label} (account not known)`, firstConnectedAt: r.createdAt, servers: new Set<string>() };
      entry.servers.add(r.serverName);
      byAccount.set(key, entry);
    });
    const accounts = [...byAccount.values()].map((a) => ({ label: a.label, revoked: false, firstConnectedAt: a.firstConnectedAt, servers: [...a.servers] }));
    providers.unshift({ provider: "box", cap: null, linked: accounts.length, everLinked: accounts.length, status: "none", accounts });
  }

  const [new7, new30, active7, active30] = await series(
    one(ex.select({ n: count() }).from(profiles).where(and(eq(profiles.isGuest, false), gt(profiles.createdAt, since(7))))),
    one(ex.select({ n: count() }).from(profiles).where(and(eq(profiles.isGuest, false), gt(profiles.createdAt, since(30))))),
    one(ex.select({ n: countDistinct(viewers.accountId) }).from(watchState).innerJoin(viewers, eq(watchState.viewerId, viewers.id)).where(gt(watchState.updatedAt, since(7)))),
    one(ex.select({ n: countDistinct(viewers.accountId) }).from(watchState).innerJoin(viewers, eq(watchState.viewerId, viewers.id)).where(gt(watchState.updatedAt, since(30)))),
  );

  const needsReauth = await ex
    .select({ serverName: servers.name, label: storageConnections.label, provider: storageConnections.provider })
    .from(storageConnections)
    .innerJoin(servers, eq(storageConnections.serverId, servers.id))
    .where(eq(storageConnections.authStatus, "needs_reauth"))
    .orderBy(servers.name);

  // The latest scan of each library, when it had errors.
  const latest = await ex
    .selectDistinctOn([scanRuns.libraryId], { libraryId: scanRuns.libraryId, errors: scanRuns.errors, finishedAt: scanRuns.finishedAt })
    .from(scanRuns)
    .orderBy(scanRuns.libraryId, desc(scanRuns.startedAt));
  const withErrors = latest.map((l) => ({ ...l, errors: splitScanMessages(l.errors ?? []).errors })).filter((l) => l.errors.length > 0);
  const libNames = await ex.select({ id: libraries.id, name: libraries.name, serverName: servers.name, lastScannedAt: libraries.lastScannedAt }).from(libraries).innerJoin(servers, eq(libraries.serverId, servers.id));
  const byId = new Map(libNames.map((l) => [l.id, l]));
  const scanErrors = withErrors
    .filter((l) => byId.has(l.libraryId))
    .map((l) => ({ serverName: byId.get(l.libraryId)!.serverName, libraryName: byId.get(l.libraryId)!.name, errors: l.errors!.length, first: l.errors![0], finishedAt: l.finishedAt }))
    .slice(0, 25);
  const neverScanned = libNames.filter((l) => !l.lastScannedAt).map((l) => ({ serverName: l.serverName, libraryName: l.name }));

  const probeRows = await ex.select({ status: mediaFiles.probeStatus, n: count() }).from(mediaFiles).where(and(isNull(mediaFiles.variantOfMediaFileId), isNotNull(mediaFiles.ownerKind), ne(mediaFiles.probeStatus, "ok"))).groupBy(mediaFiles.probeStatus);
  const probe = (s: string) => probeRows.find((r) => r.status === s)?.n ?? 0;

  const [tmdbTotals, due, oldest, lastRun] = await series(
    one(ex.select({ n: count() }).from(tmdbEntries).where(sql`${tmdbEntries.kind} IN ('movie','tv')`)),
    one(ex.select({ n: count() }).from(tmdbEntries).where(and(sql`${tmdbEntries.kind} IN ('movie','tv')`, lt(tmdbEntries.fetchedAt, new Date(now.getTime() - FRESH_MS)), isNull(tmdbEntries.missingAt)))),
    one(ex.select({ at: min(tmdbEntries.fetchedAt) }).from(tmdbEntries).where(sql`${tmdbEntries.kind} IN ('movie','tv')`)),
    async () => (await ex.select().from(platformJobs).where(eq(platformJobs.name, "tmdb-refresh")).limit(1))[0] ?? null,
  );

  // Per library type. Episodes and files hang off titles, so each is counted on its own (joining them would multiply the rows).
  const kindTotals = await ex
    .select({ kind: libraries.kind, libraries: countDistinct(libraries.id), items: count(titles.id) })
    .from(libraries)
    .leftJoin(titles, eq(titles.libraryId, libraries.id))
    .groupBy(libraries.kind);
  const kindEpisodes = await ex
    .select({ kind: libraries.kind, n: count(episodes.id) })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .groupBy(libraries.kind);
  const mainFile = and(isNull(mediaFiles.variantOfMediaFileId));
  const titleFiles = await ex
    .select({ kind: libraries.kind, n: count(mediaFiles.id), bytes: sum(mediaFiles.sizeBytes) })
    .from(mediaFiles)
    .innerJoin(titles, and(eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.ownerKind, "title")))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(mainFile)
    .groupBy(libraries.kind);
  const episodeFiles = await ex
    .select({ kind: libraries.kind, n: count(mediaFiles.id), bytes: sum(mediaFiles.sizeBytes) })
    .from(mediaFiles)
    .innerJoin(episodes, and(eq(mediaFiles.ownerId, episodes.id), eq(mediaFiles.ownerKind, "episode")))
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(mainFile)
    .groupBy(libraries.kind);
  const itemsByKind = kindTotals
    .map((k) => {
      const files = [...titleFiles, ...episodeFiles].filter((f) => f.kind === k.kind);
      return {
        kind: k.kind as string,
        libraries: k.libraries,
        items: k.items,
        episodes: kindEpisodes.find((e) => e.kind === k.kind)?.n ?? 0,
        files: files.reduce((a, f) => a + f.n, 0),
        bytes: files.reduce((a, f) => a + Number(f.bytes ?? 0), 0),
      };
    })
    .sort((a, b) => b.items - a.items);

  const serverRows = await ex
    .select({
      id: servers.id,
      name: servers.name,
      owner: profiles.email,
      createdAt: servers.createdAt,
      dddAccess: servers.dddAccess,
      members: sql<number>`(select count(*)::int from ${serverMembers} m where m.server_id = ${servers.id})`,
      libraries: sql<number>`(select count(*)::int from ${libraries} l where l.server_id = ${servers.id})`,
      titles: sql<number>`(select count(*)::int from ${titles} t join ${libraries} l on l.id = t.library_id where l.server_id = ${servers.id})`,
      connections: sql<number>`(select count(*)::int from ${storageConnections} c where c.server_id = ${servers.id})`,
    })
    .from(servers)
    .innerJoin(profiles, eq(servers.ownerId, profiles.id))
    .orderBy(desc(servers.createdAt));

  return {
    totals: { accounts: accounts.n, guests: guests.n, servers: serverCount.n, libraries: libCount.n, titles: titleCount.n, episodes: episodeCount.n, files: fileCount.n, pendingInvites: inviteCount.n },
    librariesByKind,
    connections,
    providers,
    activity: { newAccounts7: new7.n, newAccounts30: new30.n, active7: active7.n, active30: active30.n },
    health: {
      needsReauth,
      scanErrors,
      neverScanned,
      probes: { pending: probe("pending"), failed: probe("failed") },
      tmdb: { entries: tmdbTotals.n, due: due.n, oldestDays: oldest.at ? Math.floor((now.getTime() - oldest.at.getTime()) / DAY) : null, lastRun: lastRun ? { at: lastRun.lastRunAt, summary: lastRun.summary } : null },
    },
    itemsByKind,
    servers: serverRows,
  };
}
