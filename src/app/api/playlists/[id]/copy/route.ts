import { z } from "zod";
import { db } from "@/lib/db/client";
import { badRequest, isUuid, notFound, playlistName, readJson, requireActor, respond, throttled } from "@/lib/playlists/http";
import { copyPlaylist } from "@/lib/playlists/service";

const bodySchema = z.object({ name: playlistName.optional() });

/** Copy a playlist you can see: private, yours, the items you may see, no shares. */
export async function POST(request: Request, ctx: RouteContext<"/api/playlists/[id]/copy">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = bodySchema.safeParse((await readJson(request)) ?? {});
  if (!parsed.success) return badRequest(parsed.error);
  const slow = await throttled(who.actor.accountId, "playlist_copy", 20, 60);
  if (slow) return slow;
  return respond(
    await copyPlaylist(db, { playlistId: id, viewerId: who.actor.viewerId, name: parsed.data.name }),
    (v) => ({ id: v.playlist.id, name: v.playlist.name, itemsCopied: v.itemsCopied }),
    201
  );
}
