/**
 * Item operations. Every mutation locks the playlist row first, then re-reads
 * the actor (role, restrictions) under that lock, so a revoked editor or a
 * freshly restricted profile can't slip through on stale facts.
 */
import { and, asc, eq, gt, max, ne, or, sql } from "drizzle-orm";
import { playlistItems, playlists } from "@/lib/db/schema";
import { loadContext } from "./context";
import type { Executor } from "./executor";
import { findAddableTarget, findVisibleItem, listVisibleItems, type ItemCursor, type ItemsPage } from "./items";
import { appendPosition, planMove } from "./position";
import { CONTENTION_CODES, FK_VIOLATION, retryOnContention } from "./retry";
import { fail, NOT_FOUND, ok, type Result } from "./results";

const WRITE_RETRY_CODES = [...CONTENTION_CODES, FK_VIOLATION];

async function touch(ex: Executor, playlistId: string) {
  await ex.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
}

export async function listItems(
  ex: Executor,
  args: { playlistId: string; viewerId: string; limit?: number; after?: ItemCursor | null }
): Promise<Result<ItemsPage>> {
  const ctx = await loadContext(ex, args);
  if (!ctx) return NOT_FOUND;
  return ok(
    await listVisibleItems(ex, {
      playlistId: ctx.playlist.id,
      lib: ctx.lib,
      viewer: ctx.access,
      limit: args.limit,
      after: args.after,
    })
  );
}

export async function addItem(
  ex: Executor,
  args: { playlistId: string; viewerId: string; titleId?: string; episodeId?: string }
): Promise<Result<{ id: string; position: number }>> {
  // Cheap pre-checks for a fast 404/403; the transaction below re-checks under the lock.
  const pre = await loadContext(ex, args);
  if (!pre) return NOT_FOUND;
  if (!pre.caps.canEditItems) return fail(403, "You can't change this playlist's items.");
  if (!(await findAddableTarget(ex, { lib: pre.lib, viewer: pre.access, ...pickTarget(args) }))) return NOT_FOUND;

  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<{ id: string; position: number }>> => {
        const ctx = await loadContext(tx, { playlistId: args.playlistId, viewerId: args.viewerId, lock: true });
        if (!ctx) return NOT_FOUND;
        if (!ctx.caps.canEditItems) return fail(403, "You can't change this playlist's items.");
        const target = await findAddableTarget(tx, { lib: ctx.lib, viewer: ctx.access, ...pickTarget(args) });
        if (!target) return NOT_FOUND;

        // Only the same title / same episode counts as a duplicate (a show and one of its episodes may coexist).
        const [dupe] = await tx
          .select({ id: playlistItems.id })
          .from(playlistItems)
          .where(
            and(
              eq(playlistItems.playlistId, ctx.playlist.id),
              "titleId" in target ? eq(playlistItems.titleId, target.titleId) : eq(playlistItems.episodeId, target.episodeId)
            )
          );
        if (dupe) return fail(409, "Already in this playlist.");

        const [{ top }] = await tx
          .select({ top: max(playlistItems.position) })
          .from(playlistItems)
          .where(eq(playlistItems.playlistId, ctx.playlist.id));
        const [row] = await tx
          .insert(playlistItems)
          .values({
            playlistId: ctx.playlist.id,
            ...target,
            position: appendPosition(top === null || top === undefined ? null : Number(top)),
            addedByViewerId: ctx.viewer.id,
          })
          .returning({ id: playlistItems.id, position: playlistItems.position });
        await touch(tx, ctx.playlist.id);
        return ok({ id: row.id, position: row.position });
      }),
    WRITE_RETRY_CODES
  );
}

function pickTarget(args: { titleId?: string; episodeId?: string }) {
  return args.titleId ? { titleId: args.titleId } : { episodeId: args.episodeId };
}

export async function removeItem(ex: Executor, args: { playlistId: string; viewerId: string; itemId: string }): Promise<Result<true>> {
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<true>> => {
        const ctx = await loadContext(tx, { playlistId: args.playlistId, viewerId: args.viewerId, lock: true });
        if (!ctx) return NOT_FOUND;
        if (!ctx.caps.canEditItems) return fail(403, "You can't change this playlist's items.");
        // An item the actor can't see answers exactly like a missing one.
        if (!(await findVisibleItem(tx, { ...args, lib: ctx.lib, viewer: ctx.access }))) return NOT_FOUND;
        await tx.delete(playlistItems).where(and(eq(playlistItems.id, args.itemId), eq(playlistItems.playlistId, ctx.playlist.id)));
        await touch(tx, ctx.playlist.id);
        return ok(true);
      }),
    WRITE_RETRY_CODES
  );
}

/**
 * Moves `itemId` to just after `afterItemId` (null = the top). Neighbours are
 * taken from the FULL list, hidden items included, so the mover's visible order
 * comes out exactly as asked and hidden items are untouched.
 */
export async function moveItem(
  ex: Executor,
  args: { playlistId: string; viewerId: string; itemId: string; afterItemId: string | null }
): Promise<Result<{ position: number }>> {
  if (args.afterItemId === args.itemId) return fail(400, "An item can't be moved after itself.");
  return retryOnContention(
    () =>
      ex.transaction(async (tx): Promise<Result<{ position: number }>> => {
        const ctx = await loadContext(tx, { playlistId: args.playlistId, viewerId: args.viewerId, lock: true });
        if (!ctx) return NOT_FOUND;
        if (!ctx.caps.canEditItems) return fail(403, "You can't change this playlist's items.");
        const scope = { playlistId: ctx.playlist.id, lib: ctx.lib, viewer: ctx.access };
        if (!(await findVisibleItem(tx, { ...scope, itemId: args.itemId }))) return NOT_FOUND;
        if (args.afterItemId && !(await findVisibleItem(tx, { ...scope, itemId: args.afterItemId }))) return NOT_FOUND;

        const neighbours = async () => {
          const after = args.afterItemId
            ? (await tx
                .select({ id: playlistItems.id, position: playlistItems.position })
                .from(playlistItems)
                .where(eq(playlistItems.id, args.afterItemId)))[0]
            : undefined;
          const [next] = await tx
            .select({ position: playlistItems.position })
            .from(playlistItems)
            .where(
              and(
                eq(playlistItems.playlistId, ctx.playlist.id),
                ne(playlistItems.id, args.itemId),
                after
                  ? or(
                      gt(playlistItems.position, after.position),
                      and(eq(playlistItems.position, after.position), gt(playlistItems.id, after.id))
                    )
                  : undefined
              )
            )
            .orderBy(asc(playlistItems.position), asc(playlistItems.id))
            .limit(1);
          return planMove(after ? after.position : null, next ? next.position : null);
        };

        // The anchor can be deleted by a scan (which doesn't take the playlist lock) after the check above.
        if (args.afterItemId && !(await tx.select({ id: playlistItems.id }).from(playlistItems).where(and(eq(playlistItems.id, args.afterItemId), eq(playlistItems.playlistId, ctx.playlist.id)))).length) {
          return NOT_FOUND;
        }
        let plan = await neighbours();
        if ("renumber" in plan) {
          await tx.execute(sql`
            UPDATE playlist_items pi SET position = r.rn * 1024
            FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS rn FROM playlist_items WHERE playlist_id = ${ctx.playlist.id}) r
            WHERE pi.id = r.id`);
          plan = await neighbours();
        }
        if ("renumber" in plan) return fail(409, "Couldn't move that item; try again.");
        const moved = await tx
          .update(playlistItems)
          .set({ position: plan.position })
          .where(and(eq(playlistItems.id, args.itemId), eq(playlistItems.playlistId, ctx.playlist.id)))
          .returning({ id: playlistItems.id });
        if (moved.length === 0) return NOT_FOUND;
        await touch(tx, ctx.playlist.id);
        return ok({ position: plan.position });
      }),
    WRITE_RETRY_CODES
  );
}
