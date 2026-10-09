import { db } from "@/lib/db/client";
import { episodes, titles } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { tvPlaylists } from "@/lib/tv/playlists";
import { findAddableTarget } from "@/lib/playlists/items";
import { addItem } from "@/lib/playlists/item-service";
import { addToPlaylistPage, messagePage } from "@/tv/render";

/** A "back" address from a form or link, kept only if it is one of this server's TV pages. */
function safeBack(base: string, raw: string | null): string {
  return raw && raw.startsWith(`${base}/`) && !/[\\\u0000-\u001f]|\/\//.test(raw.slice(base.length)) && raw.length < 600 ? raw : base;
}

const targetFrom = (get: (name: string) => string | null | undefined) => {
  const title = asUuid(get("title") ?? "");
  const episode = asUuid(get("episode") ?? "");
  return title ? { field: "title" as const, id: title } : episode ? { field: "episode" as const, id: episode } : null;
};

/** The playlists this profile can add to, for something it may see. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/add">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const query = new URL(request.url).searchParams;
  const target = targetFrom((n) => query.get(n));
  if (!target) return notFoundPage();
  const addable = await findAddableTarget(db, { lib: access.scope.actor, viewer: access.scope.viewer, ...(target.field === "title" ? { titleId: target.id } : { episodeId: target.id }) });
  if (!addable) return notFoundPage();
  let what = "";
  if (target.field === "title") what = (await db.select({ name: titles.name }).from(titles).where(eq(titles.id, target.id)))[0]?.name ?? "";
  else what = (await db.select({ name: episodes.name }).from(episodes).where(eq(episodes.id, target.id)))[0]?.name ?? "This episode";
  const lists = (await tvPlaylists(db, access.scope)).filter((p) => p.canAdd);
  return html(
    addToPlaylistPage({
      base: access.base,
      what,
      target,
      back: safeBack(access.base, query.get("back")),
      playlists: lists.map((p) => ({ id: p.id, name: p.name, note: `${p.itemCount} ${p.itemCount === 1 ? "item" : "items"}` })),
    })
  );
}

/** Adds it. Only a POST changes anything, and a POST from another site is refused. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/add">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const form = await request.formData();
  const field = (n: string) => (typeof form.get(n) === "string" ? (form.get(n) as string) : null);
  const target = targetFrom(field);
  const playlistId = asUuid(field("playlist") ?? "");
  if (!target || !playlistId) return notFoundPage();
  const back = safeBack(access.base, field("back"));
  const result = await addItem(db, { playlistId, viewerId: access.scope.viewerId, ...(target.field === "title" ? { titleId: target.id } : { episodeId: target.id }) });
  const done = (title: string, message: string) => html(messagePage(title, message, { href: back, label: "Back" }), result.ok ? 200 : result.status === 409 ? 200 : 404);
  if (result.ok) return done("Added", "Added to your playlist.");
  if (result.status === 409) return done("Already there", "That is already in this playlist.");
  return done("Couldn't add it", "That playlist can't be changed.");
}
