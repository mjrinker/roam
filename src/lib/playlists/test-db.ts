import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";

export type TestDb = PgliteDatabase<typeof schema>;

/**
 * A throwaway in-memory Postgres with every repo migration applied (real
 * constraints, indexes, locks). The migration files are executed directly in
 * journal order, one `exec` per file, because some hand-written migrations hold
 * several statements without drizzle's statement-breakpoint markers, which
 * drizzle's own migrator would send as one prepared statement.
 */
export async function createTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const client = new PGlite();
  const folder = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    await client.exec(readFileSync(path.join(folder, `${tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return { db: drizzle(client, { schema }), close: () => client.close() };
}

let counter = 0;
const uid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const slug = () => `x${++counter}`;

/** An account (profiles row) with its default owner viewer, which reuses the account id like production. */
export async function makeAccount(db: TestDb, name = "acct") {
  const id = uid();
  await db.insert(schema.profiles).values({ id, email: `${slug()}@test.dev`, displayName: name });
  const [viewer] = await db
    .insert(schema.viewers)
    .values({ id, accountId: id, name, role: "owner" })
    .returning();
  return { accountId: id, viewer };
}

export async function makeViewer(db: TestDb, accountId: string, over: Partial<typeof schema.viewers.$inferInsert> = {}) {
  const [viewer] = await db
    .insert(schema.viewers)
    .values({ accountId, name: slug(), role: "admin", ...over })
    .returning();
  return viewer;
}

export async function makeServer(db: TestDb, ownerAccountId: string) {
  const [server] = await db.insert(schema.servers).values({ name: slug(), ownerId: ownerAccountId }).returning();
  await db.insert(schema.serverMembers).values({ serverId: server.id, profileId: ownerAccountId, role: "admin" });
  return server;
}

export async function joinServer(db: TestDb, serverId: string, accountId: string, role: "admin" | "viewer" = "viewer") {
  await db.insert(schema.serverMembers).values({ serverId, profileId: accountId, role });
}

export async function makeLibrary(
  db: TestDb,
  serverId: string,
  kind: "movies" | "shows" | "audiobooks" | "video" | "audio" = "movies",
  access: "everyone" | "restricted" = "everyone"
) {
  const [library] = await db.insert(schema.libraries).values({ serverId, name: slug(), kind, access, boxFolderId: slug() }).returning();
  return library;
}

export async function makeTitle(
  db: TestDb,
  libraryId: string,
  over: Partial<typeof schema.titles.$inferInsert> = {}
) {
  const [title] = await db
    .insert(schema.titles)
    .values({ libraryId, kind: "movie", name: slug(), boxFolderId: slug(), ...over })
    .returning();
  return title;
}

/** A show with `episodeCount` episodes in season 1. */
export async function makeShow(db: TestDb, libraryId: string, episodeCount = 2, over: Partial<typeof schema.titles.$inferInsert> = {}) {
  const show = await makeTitle(db, libraryId, { kind: "show", ...over });
  const [season] = await db.insert(schema.seasons).values({ titleId: show.id, number: 1, boxFolderId: slug() }).returning();
  const eps = [];
  for (let n = 1; n <= episodeCount; n++) {
    const [ep] = await db.insert(schema.episodes).values({ seasonId: season.id, number: n, name: `Ep ${n}` }).returning();
    eps.push(ep);
  }
  return { show, season, episodes: eps };
}

export async function makePlaylist(
  db: TestDb,
  over: { serverId: string; ownerViewerId: string | null; visibility?: "private" | "server"; name?: string }
) {
  const [playlist] = await db
    .insert(schema.playlists)
    .values({ name: "list", visibility: "private", ...over })
    .returning();
  return playlist;
}

export async function addMember(
  db: TestDb,
  playlistId: string,
  viewerId: string,
  role: "editor" | "sharer" | "viewer" = "viewer",
  grantedByViewerId: string | null = null
) {
  await db.insert(schema.playlistMembers).values({ playlistId, viewerId, role, grantedByViewerId });
}

export async function addItem(
  db: TestDb,
  playlistId: string,
  target: { titleId: string } | { episodeId: string },
  position = 1024
) {
  const [item] = await db
    .insert(schema.playlistItems)
    .values({ playlistId, position, ...("titleId" in target ? { titleId: target.titleId } : { episodeId: target.episodeId }) })
    .returning();
  return item;
}

export async function addEpisodeFile(db: TestDb, episodeId: string) {
  await db.insert(schema.mediaFiles).values({ ownerKind: "episode", ownerId: episodeId, boxFileId: slug(), filename: `${slug()}.mp4` });
}

export async function setProgress(
  db: TestDb,
  viewerId: string,
  episodeId: string,
  state: { finished?: boolean; positionSeconds?: number; updatedAt?: Date }
) {
  await db.insert(schema.watchState).values({
    viewerId,
    ownerKind: "episode",
    ownerId: episodeId,
    finished: state.finished ?? false,
    positionSeconds: state.positionSeconds ?? 0,
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
  });
}

/** A server admin's view of the libraries on `serverId` (admins see every library). */
export function adminLib(serverId: string) {
  return { serverId, accountId: "00000000-0000-4000-8000-000000000000", isAdmin: true };
}
