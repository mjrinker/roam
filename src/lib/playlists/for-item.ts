import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { playlistItems, playlistMembers, playlists, serverMembers, viewers } from "@/lib/db/schema";
import type { Executor } from "./executor";
import { findAddableTarget } from "./items";
import { capabilities } from "./permissions";
import { NOT_FOUND, ok, type Result } from "./results";
import { serverMembershipOf } from "./service";

export interface EditablePlaylist {
  id: string;
  name: string;
  /** The playlist's item row for this title/episode, or null when it isn't in the playlist yet. */
  itemId: string | null;
}

/**
 * The playlists this viewer may add to (owner, or an editor on a playlist that
 * still has an owner), each marked with whether it already contains the given
 * title or episode — what the "Add to playlist" menu shows as checkboxes. The
 * target must be something the viewer could add at all, else 404.
 */
export async function listEditablePlaylistsForItem(
  ex: Executor,
  args: { serverId: string; viewerId: string; titleId?: string; episodeId?: string; limit?: number }
): Promise<Result<EditablePlaylist[]>> {
  const membership = await serverMembershipOf(ex, args.viewerId, args.serverId);
  if (!membership) return NOT_FOUND;
  const [viewer] = await ex.select().from(viewers).where(eq(viewers.id, args.viewerId));
  if (!viewer) return NOT_FOUND;
  const access = { locale: viewer.locale, maxAge: viewer.maxAge, allowUnrated: viewer.allowUnrated };
  const target = await findAddableTarget(ex, { lib: { serverId: args.serverId, accountId: viewer.accountId, isAdmin: membership.role === "admin" }, viewer: access, titleId: args.titleId, episodeId: args.episodeId });
  if (!target) return NOT_FOUND;

  const editable = await editablePlaylistRows(ex, { serverId: args.serverId, viewer, membership, limit: args.limit });
  if (editable.length === 0) return ok([]);

  const present = await ex
    .select({ id: playlistItems.id, playlistId: playlistItems.playlistId })
    .from(playlistItems)
    .where(
      and(
        inArray(playlistItems.playlistId, editable.map((e) => e.playlist.id)),
        "titleId" in target ? eq(playlistItems.titleId, target.titleId) : eq(playlistItems.episodeId, target.episodeId)
      )
    );
  const itemByPlaylist = new Map(present.map((p) => [p.playlistId, p.id]));
  return ok(editable.map((e) => ({ id: e.playlist.id, name: e.playlist.name, itemId: itemByPlaylist.get(e.playlist.id) ?? null })));
}

/** Every playlist this viewer may add to (see listEditablePlaylistsForItem), without regard to any one item. */
export async function listEditablePlaylists(ex: Executor, args: { serverId: string; viewerId: string; limit?: number }): Promise<Result<{ id: string; name: string }[]>> {
  const membership = await serverMembershipOf(ex, args.viewerId, args.serverId);
  if (!membership) return NOT_FOUND;
  const [viewer] = await ex.select().from(viewers).where(eq(viewers.id, args.viewerId));
  if (!viewer) return NOT_FOUND;
  const rows = await editablePlaylistRows(ex, { serverId: args.serverId, viewer, membership, limit: args.limit });
  return ok(rows.map((r) => ({ id: r.playlist.id, name: r.playlist.name })));
}

async function editablePlaylistRows(
  ex: Executor,
  args: { serverId: string; viewer: typeof viewers.$inferSelect; membership: { role: string }; limit?: number }
) {
  const { viewer, membership } = args;
  // My playlists and ones I'm a member of (the pure rules below decide who can really edit).
  const mine = await ex
    .select({ playlist: playlists, role: playlistMembers.role })
    .from(playlists)
    .leftJoin(playlistMembers, and(eq(playlistMembers.playlistId, playlists.id), eq(playlistMembers.viewerId, viewer.id)))
    .where(and(eq(playlists.serverId, args.serverId), or(eq(playlists.ownerViewerId, viewer.id), eq(playlistMembers.role, "editor"))))
    .orderBy(desc(playlists.updatedAt), asc(playlists.name))
    .limit(Math.min(args.limit ?? 100, 200));

  const ownerIds = [...new Set(mine.map((r) => r.playlist.ownerViewerId).filter((id): id is string => Boolean(id)))];
  const owners = ownerIds.length
    ? await ex
        .select({ id: viewers.id })
        .from(viewers)
        .innerJoin(serverMembers, eq(serverMembers.profileId, viewers.accountId))
        .where(and(inArray(viewers.id, ownerIds), eq(serverMembers.serverId, args.serverId)))
    : [];
  const ownerOnServer = new Set(owners.map((o) => o.id));

  const editable = mine.filter(
    (r) =>
      capabilities(
        {
          ownerViewerId: r.playlist.ownerViewerId,
          ownerAccountIsMember: r.playlist.ownerViewerId ? ownerOnServer.has(r.playlist.ownerViewerId) : false,
          visibility: r.playlist.visibility,
        },
        {
          viewerId: viewer.id,
          accountId: viewer.accountId,
          viewerRole: viewer.role,
          isServerMember: true,
          isServerAdmin: membership.role === "admin",
        },
        r.role ?? null
      ).canEditItems
  );
  return editable;
}
