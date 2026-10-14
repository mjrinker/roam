import { NextResponse } from "next/server";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { dddConfigured } from "@/lib/ddd/client";
import { dddTarget, serverDddAccess } from "@/lib/ddd/lookup";
import { dddFor } from "@/lib/ddd/service";
import { dddCues, dddGuideLines } from "@/lib/ddd/transform";
import { db } from "@/lib/db/client";

/**
 * The community's scenes for a movie or episode, asked for (if this server's access level allows it and nothing is kept yet) just before
 * someone plays it, so the choices dialog can list them. Same checks as playing: the person must be a member who may see the title.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/ddd/[ownerKind]/[ownerId]">) {
  const { ownerKind, ownerId } = await ctx.params;
  if (ownerKind !== "title" && ownerKind !== "episode") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await authorizeOwner(ownerKind, ownerId);
  if (!auth.ok) return NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status });
  const headers = { "Cache-Control": "no-store" };
  const access = dddConfigured() ? await serverDddAccess(db, auth.serverId) : "disabled";
  if (access === "disabled") return NextResponse.json({ status: "off", lines: [] }, { headers });
  const target = await dddTarget(db, ownerKind, ownerId);
  if (!target) return NextResponse.json({ status: "off", lines: [] }, { headers });
  const answer = await dddFor(target.lookup, access, "play", { timeoutMs: 2500 });
  return NextResponse.json({ status: answer.status, lines: answer.status === "ok" ? dddGuideLines(dddCues(answer.data, target.owner)) : [] }, { headers });
}
