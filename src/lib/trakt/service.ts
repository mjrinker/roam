/** A profile's Trakt connection: kept encrypted, refreshed when it runs out, and used to send what the profile finishes and rates (best effort) and to bring its history in. */
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, seasons, titles, traktLinks } from "@/lib/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { applyImport, type BackupScope, type ImportResult } from "@/lib/backup/service";
import type { ItemRef } from "@/lib/backup/format";
import { Trakt, TraktError, traktConfig, type TraktTokens } from "./client";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export async function linkOf(ex: Db, viewerId: string) {
  const [row] = await ex.select().from(traktLinks).where(eq(traktLinks.viewerId, viewerId)).limit(1);
  return row ?? null;
}

export async function saveLink(ex: Db, viewerId: string, tokens: TraktTokens, username: string | null): Promise<void> {
  const values = { accessTokenEncrypted: encrypt(tokens.accessToken), refreshTokenEncrypted: encrypt(tokens.refreshToken), expiresAt: tokens.expiresAt, username };
  await ex.insert(traktLinks).values({ viewerId, ...values }).onConflictDoUpdate({ target: traktLinks.viewerId, set: values });
}

export const unlink = async (ex: Db, viewerId: string) => void (await ex.delete(traktLinks).where(eq(traktLinks.viewerId, viewerId)));

/** A usable access token for the profile, refreshed (and kept) when it is about to run out; null when not connected or Trakt isn't set up. */
export async function freshToken(ex: Db, client: Trakt, viewerId: string, now: Date = new Date()): Promise<string | null> {
  const link = await linkOf(ex, viewerId);
  if (!link) return null;
  if (link.expiresAt.getTime() - now.getTime() > 5 * 60_000) return decrypt(link.accessTokenEncrypted);
  const tokens = await client.refresh(decrypt(link.refreshTokenEncrypted));
  await saveLink(ex, viewerId, tokens, link.username);
  return tokens.accessToken;
}

/** The movie or episode as Trakt will want it named (a show's TMDB id, with the episode's place in it). */
export async function refFor(ex: Db, kind: "title" | "episode", id: string): Promise<ItemRef | null> {
  if (kind === "title") {
    const [t] = await ex.select({ kind: titles.kind, name: titles.name, year: titles.year, tmdbId: titles.tmdbId }).from(titles).where(eq(titles.id, id)).limit(1);
    return t && (t.kind === "movie" || t.kind === "show") ? { kind: t.kind, title: t.name, year: t.year, tmdbId: t.tmdbId } : null;
  }
  const [e] = await ex
    .select({ season: seasons.number, number: episodes.number, name: titles.name, year: titles.year, tmdbId: titles.tmdbId })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .innerJoin(titles, eq(titles.id, seasons.titleId))
    .where(eq(episodes.id, id))
    .limit(1);
  return e ? { kind: "episode", title: e.name, year: e.year, tmdbId: e.tmdbId, season: e.season, number: e.number } : null;
}

/** Tells Trakt a movie or episode was watched, for a connected profile. Never throws: a Trakt hiccup must not touch playback. */
export async function pushWatched(ex: Db, viewerId: string, kind: "title" | "episode", id: string, at: Date, client: Trakt | null = clientOrNull()): Promise<void> {
  try {
    if (!client || !(await linkOf(ex, viewerId))) return;
    const token = await freshToken(ex, client, viewerId);
    const ref = await refFor(ex, kind, id);
    if (token && ref) await client.addToHistory(token, ref, at);
  } catch (err) {
    if (!(err instanceof TraktError)) console.error("trakt push:", err);
  }
}

export async function pushRating(ex: Db, viewerId: string, kind: "title" | "episode", id: string, halfStars: number, client: Trakt | null = clientOrNull()): Promise<void> {
  try {
    if (!client || !(await linkOf(ex, viewerId))) return;
    const token = await freshToken(ex, client, viewerId);
    const ref = await refFor(ex, kind, id);
    if (token && ref) await client.rate(token, ref, halfStars);
  } catch (err) {
    if (!(err instanceof TraktError)) console.error("trakt rating:", err);
  }
}

/** Brings the profile's Trakt history and ratings into this server's profile. */
export async function pullFromTrakt(ex: Db, scope: BackupScope, client: Trakt): Promise<ImportResult | null> {
  const token = await freshToken(ex, client, scope.viewerId);
  if (!token) return null;
  return applyImport(ex, scope, await client.pull(token));
}

function clientOrNull(): Trakt | null {
  const config = traktConfig();
  return config ? new Trakt(config) : null;
}
export { clientOrNull as traktClient };
