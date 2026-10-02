/**
 * Playlist-level operations (create, list, read, edit, delete, copy). Each takes
 * the acting VIEWER's id (derived server-side from the session, never from the
 * client), re-reads everything it needs, and runs mutations inside a transaction
 * that locks the playlist row first. Routes stay thin wrappers around these.
 */
import { and, desc, eq, exists, inArray, lt, or, type SQL } from "drizzle-orm";
import { playlistMembers, playlists, serverMembers, viewers } from "@/lib/db/schema";
import { loadContext, type PlaylistContext } from "./context";
import type { Executor } from "./executor";
import { copyVisibleItems, countVisibleItems } from "./items";
import { maskViewer, type PublicViewer } from "./mask";
import { capabilities, type EffectiveRole, type PlaylistVisibility } from "./permissions";
import { purgeOrphanPlaylists } from "./purge";
import { CONTENTION_CODES, FK_VIOLATION, retryOnContention } from "./retry";
import { fail, NOT_FOUND, ok, type Result } from "./results";

const WRITE_RETRY_CODES = [...CONTENTION_CODES, FK_VIOLATION];

export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 500;

/** The server this viewer's account belongs to, with its role there; null when not a member. */
export async function serverMembershipOf(ex: Executor, viewerId: string, serverId: string) {
  const [row] = await ex
    .select({ accountId: viewers.accountId, role: serverMembers.role })
    .from(viewers)
    .innerJoin(serverMembers, eq(serverMembers.profileId, viewers.accountId))
    .where(and(eq(viewers.id, viewerId), eq(serverMembers.serverId, serverId)));
  return row ?? null;
}

export async function createPlaylist(
  ex: Executor,
  args: { serverId: string; viewerId: string; name: string; description?: string | null }
): Promise<Result<typeof playlists.$inferSelect>> {
  if (!(await serverMembershipOf(ex, args.viewerId, args.serverId))) return NOT_FOUND;
  const [row] = await ex
    .insert(playlists)
    .values({
      serverId: args.serverId,
      ownerViewerId: args.viewerId,
      name: args.name,
      description: args.description ?? null,
    })
    .returning();
  return ok(row);
}

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  visibility: PlaylistVisibility;
  createdAt: Date;
  updatedAt: Date;
  /** The reader's effective role, or "public" for a playlist they can see only because it is public. */
  myRole: EffectiveRole;
  owner: PublicViewer | null;
  /** Items THIS viewer can see (post-filter); never a raw count. */
  itemCount: number;
}

export type ListScope = "all" | "mine" | "shared" | "public";

export interface ListCursor {
  updatedAt: string;
  id: string;
}

export async function listPlaylists(
  ex: Executor,
  args: { serverId: string; viewerId: string; scope?: ListScope; limit?: number; after?: ListCursor | null }
): Promise<Result<{ playlists: PlaylistSummary[]; nextCursor: ListCursor | null }>> {
  const membership = await serverMembershipOf(ex, args.viewerId, args.serverId);
  if (!membership) return NOT_FOUND;
  const [viewer] = await ex.select().from(viewers).where(eq(viewers.id, args.viewerId));
  if (!viewer) return NOT_FOUND;

  // Housekeeping: never let it turn a read into an error.
  try {
    await purgeOrphanPlaylists(ex, args.serverId);
  } catch {
    /* best-effort */
  }

  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const scope = args.scope ?? "all";
  const mine = eq(playlists.ownerViewerId, viewer.id);
  const sharedWithMe = exists(
    ex
      .select({ one: playlistMembers.id })
      .from(playlistMembers)
      .where(and(eq(playlistMembers.playlistId, playlists.id), eq(playlistMembers.viewerId, viewer.id)))
  );
  const isPublic = eq(playlists.visibility, "server");
  const scoped: SQL | undefined =
    scope === "mine" ? mine : scope === "shared" ? sharedWithMe : scope === "public" ? isPublic : or(mine, sharedWithMe, isPublic);
  const cursor = args.after
    ? or(
        lt(playlists.updatedAt, new Date(args.after.updatedAt)),
        and(eq(playlists.updatedAt, new Date(args.after.updatedAt)), lt(playlists.id, args.after.id))
      )
    : undefined;

  const rows = await ex
    .select({
      playlist: playlists,
      ownerId: viewers.id,
      ownerName: viewers.name,
      ownerAvatar: viewers.avatarKey,
      ownerVisible: viewers.visibleOnServer,
      ownerAccountId: viewers.accountId,
    })
    .from(playlists)
    .leftJoin(viewers, eq(viewers.id, playlists.ownerViewerId))
    .where(and(eq(playlists.serverId, args.serverId), scoped, cursor))
    .orderBy(desc(playlists.updatedAt), desc(playlists.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const counts = await countVisibleItems(ex, {
    playlistIds: page.map((r) => r.playlist.id),
    serverId: args.serverId,
    viewer: { locale: viewer.locale, maxAge: viewer.maxAge, allowUnrated: viewer.allowUnrated },
  });

  // Roles for this page: this viewer's shares and the owners' server memberships, in two batched
  // queries, then the pure permission rules per row.
  const pageIds = page.map((r) => r.playlist.id);
  const memberRows = pageIds.length
    ? await ex
        .select({ playlistId: playlistMembers.playlistId, role: playlistMembers.role })
        .from(playlistMembers)
        .where(and(eq(playlistMembers.viewerId, viewer.id), inArray(playlistMembers.playlistId, pageIds)))
    : [];
  const memberRole = new Map(memberRows.map((m) => [m.playlistId, m.role]));
  const ownerAccountIds = [...new Set(page.map((r) => r.ownerAccountId).filter((id): id is string => Boolean(id)))];
  const stillMembers = ownerAccountIds.length
    ? await ex
        .select({ profileId: serverMembers.profileId })
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, args.serverId), inArray(serverMembers.profileId, ownerAccountIds)))
    : [];
  const memberAccounts = new Set(stillMembers.map((m) => m.profileId));

  const summaries: PlaylistSummary[] = [];
  for (const r of page) {
    const caps = capabilities(
      {
        ownerViewerId: r.playlist.ownerViewerId,
        ownerAccountIsMember: r.ownerAccountId ? memberAccounts.has(r.ownerAccountId) : false,
        visibility: r.playlist.visibility,
      },
      {
        viewerId: viewer.id,
        accountId: viewer.accountId,
        viewerRole: viewer.role,
        isServerMember: true,
        isServerAdmin: membership.role === "admin",
      },
      memberRole.get(r.playlist.id) ?? null
    );
    if (!caps.role) continue;
    summaries.push({
      id: r.playlist.id,
      name: r.playlist.name,
      description: r.playlist.description,
      visibility: r.playlist.visibility,
      createdAt: r.playlist.createdAt,
      updatedAt: r.playlist.updatedAt,
      myRole: caps.role,
      owner: r.ownerId
        ? maskViewer(
            { id: r.ownerId, name: r.ownerName!, avatarKey: r.ownerAvatar!, visibleOnServer: r.ownerVisible!, accountId: r.ownerAccountId! },
            viewer.accountId
          )
        : null,
      itemCount: counts.get(r.playlist.id) ?? 0,
    });
  }

  const last = page[page.length - 1];
  return ok({
    playlists: summaries,
    nextCursor: rows.length > limit && last ? { updatedAt: last.playlist.updatedAt.toISOString(), id: last.playlist.id } : null,
  });
}

export interface PlaylistDetail {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  visibility: PlaylistVisibility;
  createdAt: Date;
  updatedAt: Date;
  owner: PublicViewer | null;
  myRole: EffectiveRole;
  itemCount: number;
  can: {
    editItems: boolean;
    rename: boolean;
    transfer: boolean;
    delete: boolean;
    leave: boolean;
    copy: boolean;
    makePublic: boolean;
    makePrivate: boolean;
  };
}

export async function getPlaylistDetail(
  ex: Executor,
  args: { playlistId: string; viewerId: string }
): Promise<Result<PlaylistDetail>> {
  const ctx = await loadContext(ex, args);
  if (!ctx) return NOT_FOUND;
  const { playlist, caps } = ctx;
  const [owner] = playlist.ownerViewerId
    ? await ex.select().from(viewers).where(eq(viewers.id, playlist.ownerViewerId))
    : [];
  const counts = await countVisibleItems(ex, { playlistIds: [playlist.id], serverId: playlist.serverId, viewer: ctx.access });
  return ok({
    id: playlist.id,
    serverId: playlist.serverId,
    name: playlist.name,
    description: playlist.description,
    visibility: playlist.visibility,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
    owner: owner ? maskViewer(owner, ctx.viewer.accountId) : null,
    myRole: caps.role!,
    itemCount: counts.get(playlist.id) ?? 0,
    can: {
      editItems: caps.canEditItems,
      rename: caps.canRename,
      transfer: caps.canTransfer,
      delete: caps.canDelete,
      leave: caps.canLeave,
      copy: caps.canCopy,
      makePublic: caps.canSetVisibility("server"),
      makePrivate: caps.canSetVisibility("private"),
    },
  });
}

export async function patchPlaylist(
  ex: Executor,
  args: { playlistId: string; viewerId: string; name?: string; description?: string | null; visibility?: PlaylistVisibility }
): Promise<Result<typeof playlists.$inferSelect>> {
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<typeof playlists.$inferSelect>> => {
        const ctx = await loadContext(tx, { ...args, lock: true });
        if (!ctx) return NOT_FOUND;
        const { caps, playlist } = ctx;
        const changesText = args.name !== undefined || args.description !== undefined;
        if (changesText && !caps.canRename) return fail(403, "You can't rename this playlist.");
        if (args.visibility !== undefined && args.visibility !== playlist.visibility && !caps.canSetVisibility(args.visibility)) {
          return fail(403, "You can't change who can see this playlist.");
        }
        const [row] = await tx
          .update(playlists)
          .set({
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
            updatedAt: new Date(),
          })
          .where(eq(playlists.id, playlist.id))
          .returning();
        return ok(row);
      }),
    WRITE_RETRY_CODES
  );
}

export async function deletePlaylist(ex: Executor, args: { playlistId: string; viewerId: string }): Promise<Result<true>> {
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<true>> => {
        const ctx = await loadContext(tx, { ...args, lock: true });
        if (!ctx) return NOT_FOUND;
        if (!ctx.caps.canDelete) return fail(403, "You can't delete this playlist.");
        await tx.delete(playlists).where(eq(playlists.id, ctx.playlist.id));
        return ok(true);
      }),
    WRITE_RETRY_CODES
  );
}

/**
 * Anyone who can view a playlist can copy it: the copy is private, owned by the
 * copier, holds the items the COPIER may see, and carries no shares.
 */
export async function copyPlaylist(
  ex: Executor,
  args: { playlistId: string; viewerId: string; name?: string }
): Promise<Result<{ playlist: typeof playlists.$inferSelect; itemsCopied: number }>> {
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<{ playlist: typeof playlists.$inferSelect; itemsCopied: number }>> => {
        const ctx: PlaylistContext | null = await loadContext(tx, { ...args, lock: true });
        if (!ctx) return NOT_FOUND;
        if (!ctx.caps.canCopy) return NOT_FOUND;
        const name = (args.name ?? `${ctx.playlist.name} (copy)`).slice(0, NAME_MAX);
        const [created] = await tx
          .insert(playlists)
          .values({
            serverId: ctx.playlist.serverId,
            ownerViewerId: ctx.viewer.id,
            name,
            description: ctx.playlist.description,
          })
          .returning();
        const itemsCopied = await copyVisibleItems(tx, {
          sourcePlaylistId: ctx.playlist.id,
          targetPlaylistId: created.id,
          serverId: ctx.playlist.serverId,
          viewer: ctx.access,
          copierViewerId: ctx.viewer.id,
        });
        return ok({ playlist: created, itemsCopied });
      }),
    WRITE_RETRY_CODES
  );
}

