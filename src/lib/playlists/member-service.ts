/**
 * Sharing: who a playlist is shared with, ownership transfer, the share picker
 * and the admin moderation list. Mutations lock the playlist row first and
 * validate the share target under that lock (reading the target viewer
 * FOR SHARE so a profile hiding itself can't race a new share). Every way a
 * target can be invalid answers with the same 404, because viewer ids are guessable.
 */
import { and, asc, eq, gt, inArray, ne, or } from "drizzle-orm";
import { playlistMembers, playlists, serverMembers, viewers } from "@/lib/db/schema";
import { loadContext } from "./context";
import type { Executor } from "./executor";
import { maskViewer, type PublicViewer } from "./mask";
import type { MemberRole } from "./permissions";
import { purgeOrphanPlaylists } from "./purge";
import { CONTENTION_CODES, FK_VIOLATION, retryOnContention } from "./retry";
import { fail, NOT_FOUND, ok, type Result } from "./results";
import { serverMembershipOf } from "./service";

const WRITE_RETRY_CODES = [...CONTENTION_CODES, FK_VIOLATION];

type ViewerRow = typeof viewers.$inferSelect;

/** The share/transfer target, locked FOR SHARE, if it is a valid target for this actor on this server. */
async function lockTarget(
  tx: Executor,
  args: { serverId: string; targetViewerId: string; actor: ViewerRow }
): Promise<ViewerRow | null> {
  const [target] = await tx.select().from(viewers).where(eq(viewers.id, args.targetViewerId)).for("share");
  if (!target) return null;
  const [member] = await tx
    .select({ one: serverMembers.id })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, args.serverId), eq(serverMembers.profileId, target.accountId)));
  if (!member) return null;
  // Another account's profile must have opted in to being visible on the server.
  if (target.accountId !== args.actor.accountId && !target.visibleOnServer) return null;
  return target;
}

export async function addMember(
  ex: Executor,
  args: { playlistId: string; viewerId: string; targetViewerId: string; role: MemberRole }
): Promise<Result<{ viewerId: string; role: MemberRole }>> {
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<{ viewerId: string; role: MemberRole }>> => {
        const ctx = await loadContext(tx, { playlistId: args.playlistId, viewerId: args.viewerId, lock: true });
        if (!ctx) return NOT_FOUND;
        const target = await lockTarget(tx, { serverId: ctx.playlist.serverId, targetViewerId: args.targetViewerId, actor: ctx.viewer });
        // Permission first (so a viewer can't probe targets), then target validity.
        if (!ctx.caps.canShare(args.role, target?.accountId ?? "")) return fail(403, "You can't share this playlist that way.");
        if (!target || target.id === ctx.viewer.id || target.id === ctx.playlist.ownerViewerId) return NOT_FOUND;

        const isOwner = ctx.caps.role === "owner";
        const values = { playlistId: ctx.playlist.id, viewerId: target.id, role: args.role, grantedByViewerId: ctx.viewer.id };
        if (isOwner) {
          await tx
            .insert(playlistMembers)
            .values(values)
            .onConflictDoUpdate({
              target: [playlistMembers.playlistId, playlistMembers.viewerId],
              set: { role: args.role, grantedByViewerId: ctx.viewer.id, updatedAt: new Date() },
            });
        } else {
          // A sharer never overwrites or downgrades an existing share.
          await tx.insert(playlistMembers).values(values).onConflictDoNothing();
        }
        return ok({ viewerId: target.id, role: args.role });
      }),
    WRITE_RETRY_CODES
  );
}

/** Owner only: change the role on an existing share. */
export async function changeMemberRole(
  ex: Executor,
  args: { playlistId: string; viewerId: string; targetViewerId: string; role: MemberRole }
): Promise<Result<{ viewerId: string; role: MemberRole }>> {
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<{ viewerId: string; role: MemberRole }>> => {
        const ctx = await loadContext(tx, { playlistId: args.playlistId, viewerId: args.viewerId, lock: true });
        if (!ctx) return NOT_FOUND;
        const [row] = await tx
          .select({ viewerId: playlistMembers.viewerId })
          .from(playlistMembers)
          .where(and(eq(playlistMembers.playlistId, ctx.playlist.id), eq(playlistMembers.viewerId, args.targetViewerId)));
        const [target] = row ? await tx.select().from(viewers).where(eq(viewers.id, row.viewerId)) : [];
        if (ctx.caps.role !== "owner" || !ctx.caps.canShare(args.role, target?.accountId ?? "")) {
          return fail(403, "Only the owner can change roles.");
        }
        if (!row) return NOT_FOUND;
        await tx
          .update(playlistMembers)
          .set({ role: args.role, updatedAt: new Date() })
          .where(and(eq(playlistMembers.playlistId, ctx.playlist.id), eq(playlistMembers.viewerId, row.viewerId)));
        return ok({ viewerId: row.viewerId, role: args.role });
      }),
    WRITE_RETRY_CODES
  );
}

/**
 * Remove a share. Anyone may remove their OWN ("leave playlist"); the owner may
 * remove any; a sharer only the viewer shares they granted. Leaving can orphan
 * an ownerless playlist, so it is collected in the same transaction.
 */
export async function removeMember(
  ex: Executor,
  args: { playlistId: string; viewerId: string; targetViewerId: string }
): Promise<Result<true>> {
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<true>> => {
        const ctx = await loadContext(tx, { playlistId: args.playlistId, viewerId: args.viewerId, lock: true });
        if (!ctx) return NOT_FOUND;
        const [row] = await tx
          .select()
          .from(playlistMembers)
          .where(and(eq(playlistMembers.playlistId, ctx.playlist.id), eq(playlistMembers.viewerId, args.targetViewerId)));
        const leaving = args.targetViewerId === ctx.viewer.id;
        // Not allowed answers like "no such share" so share rows aren't probeable.
        if (!row || !(leaving ? ctx.caps.canLeave : ctx.caps.canRevoke(row))) return NOT_FOUND;
        await tx
          .delete(playlistMembers)
          .where(and(eq(playlistMembers.playlistId, ctx.playlist.id), eq(playlistMembers.viewerId, args.targetViewerId)));
        if (leaving) await purgeOrphanPlaylists(tx, ctx.playlist.serverId);
        return ok(true);
      }),
    WRITE_RETRY_CODES
  );
}

export interface MemberView extends PublicViewer {
  role: MemberRole;
  isMe: boolean;
}

/** Owner and editors see every share; a sharer sees their own plus those they granted; a viewer only their own. */
export async function listMembers(
  ex: Executor,
  args: { playlistId: string; viewerId: string; limit?: number; after?: { createdAt: string; id: string } | null }
): Promise<Result<{ members: MemberView[]; nextCursor: { createdAt: string; id: string } | null }>> {
  const ctx = await loadContext(ex, args);
  if (!ctx) return NOT_FOUND;
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const sees =
    ctx.caps.role === "owner" || ctx.caps.role === "editor"
      ? undefined
      : ctx.caps.role === "sharer"
        ? or(eq(playlistMembers.viewerId, ctx.viewer.id), eq(playlistMembers.grantedByViewerId, ctx.viewer.id))
        : eq(playlistMembers.viewerId, ctx.viewer.id);
  const rows = await ex
    .select({ m: playlistMembers, v: viewers })
    .from(playlistMembers)
    .innerJoin(viewers, eq(viewers.id, playlistMembers.viewerId))
    .where(
      and(
        eq(playlistMembers.playlistId, ctx.playlist.id),
        sees,
        args.after
          ? or(
              gt(playlistMembers.createdAt, new Date(args.after.createdAt)),
              and(eq(playlistMembers.createdAt, new Date(args.after.createdAt)), gt(playlistMembers.id, args.after.id))
            )
          : undefined
      )
    )
    .orderBy(asc(playlistMembers.createdAt), asc(playlistMembers.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return ok({
    members: page.map((r) => ({ ...maskViewer(r.v, ctx.viewer.accountId), role: r.m.role, isMe: r.v.id === ctx.viewer.id })),
    nextCursor: rows.length > limit && last ? { createdAt: last.m.createdAt.toISOString(), id: last.m.id } : null,
  });
}

/**
 * Owner-only transfer. The target must already hold a share, still exist, belong
 * to an account on this server, not be the current owner, and not be a limited
 * profile (a limited owner could never share or publish). The old owner becomes an
 * editor, unless they're hidden and the new owner is on another account.
 */
export async function transferOwnership(
  ex: Executor,
  args: { playlistId: string; viewerId: string; targetViewerId: string }
): Promise<Result<true>> {
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<true>> => {
        const ctx = await loadContext(tx, { playlistId: args.playlistId, viewerId: args.viewerId, lock: true });
        if (!ctx) return NOT_FOUND;
        if (!ctx.caps.canTransfer) return fail(403, "Only the owner can transfer a playlist.");
        const target = await lockTarget(tx, { serverId: ctx.playlist.serverId, targetViewerId: args.targetViewerId, actor: ctx.viewer });
        const [share] = target
          ? await tx
              .select({ id: playlistMembers.id })
              .from(playlistMembers)
              .where(and(eq(playlistMembers.playlistId, ctx.playlist.id), eq(playlistMembers.viewerId, target.id)))
          : [];
        if (!target || !share || target.id === ctx.viewer.id || target.role === "limited") return NOT_FOUND;

        await tx.delete(playlistMembers).where(and(eq(playlistMembers.playlistId, ctx.playlist.id), eq(playlistMembers.viewerId, target.id)));
        await tx.update(playlists).set({ ownerViewerId: target.id, updatedAt: new Date() }).where(eq(playlists.id, ctx.playlist.id));
        const hiddenAcrossAccounts = !ctx.viewer.visibleOnServer && target.accountId !== ctx.viewer.accountId;
        if (!hiddenAcrossAccounts) {
          await tx
            .insert(playlistMembers)
            .values({ playlistId: ctx.playlist.id, viewerId: ctx.viewer.id, role: "editor", grantedByViewerId: target.id })
            .onConflictDoUpdate({
              target: [playlistMembers.playlistId, playlistMembers.viewerId],
              set: { role: "editor", updatedAt: new Date() },
            });
        }
        return ok(true);
      }),
    WRITE_RETRY_CODES
  );
}

/** Profiles this viewer may offer a share to: other members' opted-in profiles, plus siblings (limited profiles: siblings only). */
export async function sharePicker(
  ex: Executor,
  args: { serverId: string; viewerId: string; limit?: number; after?: { name: string; id: string } | null }
): Promise<Result<{ viewers: PublicViewer[]; nextCursor: { name: string; id: string } | null }>> {
  const membership = await serverMembershipOf(ex, args.viewerId, args.serverId);
  if (!membership) return NOT_FOUND;
  const [me] = await ex.select().from(viewers).where(eq(viewers.id, args.viewerId));
  if (!me) return NOT_FOUND;
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);

  const memberAccounts = ex.select({ id: serverMembers.profileId }).from(serverMembers).where(eq(serverMembers.serverId, args.serverId));
  const eligible =
    me.role === "limited"
      ? eq(viewers.accountId, me.accountId)
      : or(eq(viewers.visibleOnServer, true), eq(viewers.accountId, me.accountId));
  const rows = await ex
    .select({ id: viewers.id, name: viewers.name, avatarKey: viewers.avatarKey })
    .from(viewers)
    .where(
      and(
        inArray(viewers.accountId, memberAccounts),
        ne(viewers.id, me.id),
        eligible,
        args.after
          ? or(gt(viewers.name, args.after.name), and(eq(viewers.name, args.after.name), gt(viewers.id, args.after.id)))
          : undefined
      )
    )
    .orderBy(asc(viewers.name), asc(viewers.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return ok({ viewers: page, nextCursor: rows.length > limit && last ? { name: last.name, id: last.id } : null });
}

export interface ModerationRow {
  id: string;
  name: string;
  owner: PublicViewer | null;
  createdAt: Date;
}

/** Server admins only: one page of the server's PUBLIC playlists (the only ones an admin may delete). */
export async function listPublicForAdmin(
  ex: Executor,
  args: { serverId: string; viewerId: string; limit?: number; after?: { name: string; id: string } | null }
): Promise<Result<{ playlists: ModerationRow[]; nextCursor: { name: string; id: string } | null }>> {
  const membership = await serverMembershipOf(ex, args.viewerId, args.serverId);
  const [me] = await ex.select().from(viewers).where(eq(viewers.id, args.viewerId));
  if (!membership || !me || membership.role !== "admin" || me.role === "limited") return NOT_FOUND;
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const rows = await ex
    .select({ p: playlists, v: viewers })
    .from(playlists)
    .leftJoin(viewers, eq(viewers.id, playlists.ownerViewerId))
    .where(
      and(
        eq(playlists.serverId, args.serverId),
        eq(playlists.visibility, "server"),
        args.after
          ? or(gt(playlists.name, args.after.name), and(eq(playlists.name, args.after.name), gt(playlists.id, args.after.id)))
          : undefined
      )
    )
    .orderBy(asc(playlists.name), asc(playlists.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return ok({
    playlists: page.map((r) => ({
      id: r.p.id,
      name: r.p.name,
      owner: r.v ? maskViewer(r.v, me.accountId) : null,
      createdAt: r.p.createdAt,
    })),
    nextCursor: rows.length > limit && last ? { name: last.p.name, id: last.p.id } : null,
  });
}
