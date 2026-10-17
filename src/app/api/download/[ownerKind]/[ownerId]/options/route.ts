import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { buildDownloadOptions } from "@/lib/offline/build-options";
import { ownershipGate } from "@/lib/ownership/gate";
import { aimHeight } from "@/lib/player/data-saver";
import { pickVersion } from "@/lib/player/versions";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * The versions of a movie, episode, song or audiobook that can be saved for offline use, with their resolution and size. The same gate
 * as playing it (membership, age limit, library access); anything not allowed is the one 404, like a missing item.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/download/[ownerKind]/[ownerId]/options">) {
  const { ownerKind, ownerId } = await ctx.params;
  if ((ownerKind !== "title" && ownerKind !== "episode") || !z.string().uuid().safeParse(ownerId).success) return notFound();
  const auth = await authorizeOwner(ownerKind, ownerId);
  if (!auth.ok) return auth.status === 403 ? NextResponse.json({ error: "Forbidden" }, { status: 403 }) : notFound();
  const blocked = await ownershipGate({ viewerId: auth.member.viewer.id, accountId: auth.member.profile.id }, ownerKind, ownerId, { take: false });
  if (blocked) return blocked;
  const options = await buildDownloadOptions(ownerKind, ownerId);
  if (!options) return notFound();
  if (auth.member.viewer.dataSaver && options.kind === "watch" && options.options.length > 1) {
    options.suggestedLabel = pickVersion(options.options.map((o) => ({ label: o.label, name: o.name, height: o.height })), null, aimHeight(null, true));
  }
  return NextResponse.json(options, { headers: { "Cache-Control": "no-store" } });
}
