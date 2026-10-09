import { z } from "zod";
import { db } from "@/lib/db/client";
import { addItem, addSongs, listItems, moveItem } from "@/lib/playlists/item-service";
import { badRequest, decodeCursor, encodeCursor, isUuid, limitParam, notFound, readJson, requireActor, respond, throttled } from "@/lib/playlists/http";

const addSchema = z
  .object({ titleId: z.string().uuid().optional(), episodeId: z.string().uuid().optional(), albumId: z.string().uuid().optional(), artistId: z.string().uuid().optional() })
  .refine((v) => [v.titleId, v.episodeId, v.albumId, v.artistId].filter(Boolean).length === 1, "Provide exactly one of titleId, episodeId, albumId or artistId");
const moveSchema = z.object({ itemId: z.string().uuid(), afterItemId: z.string().uuid().nullable() });
const cursorSchema = z.object({ position: z.number(), id: z.string().uuid() });

/** One page of the items this profile may see, in playlist order. */
export async function GET(request: Request, ctx: RouteContext<"/api/playlists/[id]/items">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const url = new URL(request.url);
  const after = decodeCursor(url.searchParams.get("after"), cursorSchema);
  if (after === "invalid") return badRequest("Invalid cursor");
  const result = await listItems(db, { playlistId: id, viewerId: who.actor.viewerId, limit: limitParam(url.searchParams.get("limit")), after });
  return respond(result, (page) => ({ items: page.items.map((item) => ({ ...item, position: undefined })), nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null }));
}

export async function POST(request: Request, ctx: RouteContext<"/api/playlists/[id]/items">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = addSchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  const slow = await throttled(who.actor.accountId, "playlist_item_add", 240, 60);
  if (slow) return slow;
  // An album or an artist adds all of its songs as separate items.
  if (parsed.data.albumId || parsed.data.artistId) {
    return respond(await addSongs(db, { playlistId: id, viewerId: who.actor.viewerId, albumId: parsed.data.albumId, artistId: parsed.data.artistId }), (v) => v, 201);
  }
  return respond(await addItem(db, { playlistId: id, viewerId: who.actor.viewerId, titleId: parsed.data.titleId, episodeId: parsed.data.episodeId }), (v) => ({ id: v.id }), 201);
}

/** Move one item to just after another (or to the top with afterItemId: null). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/playlists/[id]/items">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = moveSchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  const slow = await throttled(who.actor.accountId, "playlist_item_move", 240, 60);
  if (slow) return slow;
  return respond(await moveItem(db, { playlistId: id, viewerId: who.actor.viewerId, ...parsed.data }), () => ({ ok: true }));
}
