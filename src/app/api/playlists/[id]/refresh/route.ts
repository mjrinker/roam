import { db } from "@/lib/db/client";
import { badRequest, isUuid, notFound, requireActor, respond, throttled } from "@/lib/playlists/http";
import { fail } from "@/lib/playlists/results";
import { getPlaylistDetail } from "@/lib/playlists/service";
import { refreshSmartPlaylist } from "@/lib/playlists/smart";

/** Re-runs a smart playlist's rules now (it also does so by itself when opened after a few minutes). Only for whoever may edit the playlist. */
export async function POST(_request: Request, ctx: RouteContext<"/api/playlists/[id]/refresh">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const slow = await throttled(who.actor.accountId, "playlist_refresh", 30, 60);
  if (slow) return slow;
  const detail = await getPlaylistDetail(db, { playlistId: id, viewerId: who.actor.viewerId });
  if (!detail.ok) return respond(detail);
  if (!detail.value.smart) return badRequest("Only a smart playlist can be refreshed.");
  if (!detail.value.can.rename) return respond(fail(403, "You can't change this playlist."));
  const count = await refreshSmartPlaylist(db, id, { force: true });
  return respond(detail, () => ({ ok: true, items: count ?? 0 }));
}
