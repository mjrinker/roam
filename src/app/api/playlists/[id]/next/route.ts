import { db } from "@/lib/db/client";
import { nextAfter, validShuffle } from "@/lib/playlists/next";
import { badRequest, isUuid, notFound, requireActor, respond } from "@/lib/playlists/http";

/**
 * What plays after `?after=<itemId>` in this playlist's queue — or the first playable
 * item when `after` is omitted ("Play all") — optionally with the episode just watched
 * and replay mode. `shuffle=<seed>` walks the playlist in a random order instead (the same seed, the same order). Returns { next: null } when the queue is over or empty.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/playlists/[id]/next">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const episode = url.searchParams.get("episode") ?? undefined;
  if ((after !== null && !isUuid(after)) || (episode !== undefined && !isUuid(episode))) return badRequest("Invalid request");
  const result = await nextAfter(db, {
    playlistId: id,
    viewerId: who.actor.viewerId,
    afterItemId: after ?? undefined,
    currentEpisodeId: episode,
    replay: url.searchParams.get("replay") === "1",
    shuffle: validShuffle(url.searchParams.get("shuffle")) ? (url.searchParams.get("shuffle") as string) : undefined,
  });
  return respond(result, (next) => ({ next }));
}
