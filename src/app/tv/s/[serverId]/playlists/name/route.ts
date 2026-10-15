import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { safeBack } from "@/lib/tv/form";
import { html } from "@/lib/tv/http";
import { addTargetName } from "@/lib/tv/add-target";
import { tvPlaylistCaps } from "@/lib/tv/playlist-manage";
import { NAME_MAX } from "@/lib/playlists/service";
import { nameKeyboardPage } from "@/tv/render";
import { targetFrom } from "../../add/route";

/**
 * A playlist's name, typed with the remote. With nothing else asked it makes a new empty playlist; with `playlist` it renames that one;
 * with a title, episode, album or artist it makes a new playlist and adds that to it. The name travels in the address (it is not a secret).
 */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlists/name">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const q = new URL(request.url).searchParams;
  const name = (q.get("name") ?? "").slice(0, NAME_MAX);
  const playlist = asUuid(q.get("playlist") ?? "");
  const target = targetFrom((n) => q.get(n));
  const back = safeBack(access.base, q.get("back")) === access.base ? `${access.base}/playlists` : safeBack(access.base, q.get("back"));
  let heading = "New playlist";
  let saveLabel = "Create";
  const carry: Record<string, string> = { back };
  if (playlist) {
    const caps = await tvPlaylistCaps(db, access.scope, playlist);
    if (!caps || !caps.can.rename) return notFoundPage();
    heading = "Rename playlist";
    saveLabel = "Save";
    carry.playlist = playlist;
  } else if (target) {
    carry[target.field] = target.id;
    saveLabel = "Create and add";
    // Say what is being added, so it is clear why a playlist is being made.
    const what = await addTargetName(target);
    if (what) heading = `New playlist for ${what}`;
  }
  return html(
    nameKeyboardPage({ base: access.base, heading, name, max: NAME_MAX, focusKey: q.get("k"), carry, saveLabel, backHref: back, note: name.length >= NAME_MAX ? `That's the longest a name can be (${NAME_MAX}).` : null })
  );
}
