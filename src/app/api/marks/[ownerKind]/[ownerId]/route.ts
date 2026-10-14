import { NextResponse } from "next/server";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { boxMarkWriter, loadMarks, saveMarks } from "@/lib/content-filter/save-marks";

/**
 * A film's hand-marked scenes (see lib/content-filter/save-marks): read for the player's marking panel, and replaced when it saves. Only a
 * server's admin (a non-limited profile) may; everyone else sees nothing here, exactly as for a title that doesn't exist.
 */
async function authorize(ownerKind: string, ownerId: string) {
  if (ownerKind !== "title" && ownerKind !== "episode") return null;
  const auth = await authorizeOwner(ownerKind, ownerId);
  if (!auth.ok) return null;
  if (!(await getCurrentServerAdmin(auth.serverId))) return null;
  return { kind: ownerKind as "title" | "episode", serverId: auth.serverId };
}

const none = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request, ctx: RouteContext<"/api/marks/[ownerKind]/[ownerId]">) {
  const { ownerKind, ownerId } = await ctx.params;
  const who = await authorize(ownerKind, ownerId);
  if (!who) return none();
  const version = new URL(request.url).searchParams.get("version");
  const marks = await loadMarks(db, who.kind, ownerId, version === null ? null : version.trim().toLowerCase().slice(0, 60), boxMarkWriter);
  if (!marks) return NextResponse.json({ error: "This isn't ready to mark yet." }, { status: 409, headers });
  return NextResponse.json(marks, { headers });
}

export async function PUT(request: Request, ctx: RouteContext<"/api/marks/[ownerKind]/[ownerId]">) {
  const { ownerKind, ownerId } = await ctx.params;
  const who = await authorize(ownerKind, ownerId);
  if (!who) return none();
  const body = (await request.json().catch(() => null)) as { version?: unknown; cues?: unknown } | null;
  if (!body || !Array.isArray(body.cues)) return NextResponse.json({ error: "Send the list of scenes." }, { status: 400 });
  const version = typeof body.version === "string" ? body.version.trim().toLowerCase().slice(0, 60) : null;
  try {
    const result = await saveMarks(db, { serverId: who.serverId, ownerKind: who.kind, ownerId, version, cues: body.cues, writer: boxMarkWriter });
    if (!result.ok) return NextResponse.json({ error: "This isn't ready to mark yet." }, { status: 409, headers });
    return NextResponse.json({ ...result.marks, filesWritten: result.filesWritten }, { headers });
  } catch (err) {
    console.error("saving marks:", err);
    return NextResponse.json({ error: "Couldn't save the scene file. Nothing was changed." }, { status: 502, headers });
  }
}
