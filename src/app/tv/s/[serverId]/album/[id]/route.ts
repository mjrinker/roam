import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { getAlbum } from "@/lib/music/browse";
import { newSeed, shuffled } from "@/lib/tv/shuffle";
import { formatClock } from "@/tv/client/clock";
import { finishedTitleIds } from "@/lib/tv/data";
import { doneWords } from "@/lib/watch/words";
import { detailPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/album/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const result = await getAlbum(db, { actor: access.scope.actor, viewer: access.scope.viewer, albumId: id });
  if (!result) return notFoundPage();
  const { album, tracks } = result;
  const first = tracks[0];
  // Shuffle: a fresh seed fixes the order, so every song's page agrees on what comes next.
  const seed = newSeed();
  const mixed = tracks.length > 1 ? shuffled(tracks, seed)[0] : null;
  const heard = await finishedTitleIds(db, access.scope.viewerId, tracks.map((t) => t.id));
  const albumDone = tracks.length > 0 && tracks.every((t) => heard.has(t.id));
  const here = `${access.base}/album/${id}`;
  return html(
    detailPage({
      title: album.name,
      meta: [album.artistName, album.year, `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}`].filter(Boolean).join(" · "),
      overview: null,
      posterUrl: album.coverUrl,
      square: true,
      backHref: `${access.base}/artist/${album.artistId}`,
      actions: first ? [{ href: `${access.base}/listen/${first.id}`, label: "Play album", primary: true }, ...(mixed ? [{ href: `${access.base}/listen/${mixed.id}?shuffle=${seed}`, label: "Shuffle" }] : []), { href: `${access.base}/add?album=${id}&back=${encodeURIComponent(here)}`, label: "Add to playlist" }] : [],
      posts: tracks.length
        ? [{ action: `${access.base}/mark`, label: albumDone ? doneWords("listen").markUndone : doneWords("listen").markDone, fields: { kind: "album", id, done: albumDone ? "0" : "1", back: here } }]
        : [],
      listHeading: "Songs",
      episodes: tracks.map((t, i) => ({ href: `${access.base}/listen/${t.id}`, label: `${t.trackNumber ?? i + 1}. ${t.name}`, sub: [t.artist, t.durationSeconds ? formatClock(t.durationSeconds) : null].filter(Boolean).join(" · ") || null })),
    })
  );
}
