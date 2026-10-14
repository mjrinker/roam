import { NextResponse } from "next/server";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { loadSkipMarks, saveSkipMarks } from "@/lib/skipdb/save-skip-marks";

/** A film's hand-marked intro, recap, credits and preview times (see lib/skipdb/marks). A server's admin only; everyone else gets "not found". */
async function authorize(ownerKind: string, ownerId: string) {
  if (ownerKind !== "title" && ownerKind !== "episode") return null;
  const auth = await authorizeOwner(ownerKind, ownerId);
  if (!auth.ok) return null;
  if (!(await getCurrentServerAdmin(auth.serverId))) return null;
  return ownerKind as "title" | "episode";
}
const none = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const headers = { "Cache-Control": "no-store" };
const versionOf = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 60) : null);

export async function GET(request: Request, ctx: RouteContext<"/api/skip-marks/[ownerKind]/[ownerId]">) {
  const { ownerKind, ownerId } = await ctx.params;
  const kind = await authorize(ownerKind, ownerId);
  if (!kind) return none();
  const set = await loadSkipMarks(db, kind, ownerId, versionOf(new URL(request.url).searchParams.get("version")));
  return set ? NextResponse.json(set, { headers }) : NextResponse.json({ error: "This isn't ready to mark yet." }, { status: 409, headers });
}

export async function PUT(request: Request, ctx: RouteContext<"/api/skip-marks/[ownerKind]/[ownerId]">) {
  const { ownerKind, ownerId } = await ctx.params;
  const kind = await authorize(ownerKind, ownerId);
  if (!kind) return none();
  const body = (await request.json().catch(() => null)) as { version?: unknown; marks?: unknown } | null;
  if (!body || !Array.isArray(body.marks)) return NextResponse.json({ error: "Send the list of times." }, { status: 400 });
  const set = await saveSkipMarks(db, { ownerKind: kind, ownerId, version: versionOf(body.version), marks: body.marks });
  return set ? NextResponse.json(set, { headers }) : NextResponse.json({ error: "This isn't ready to mark yet." }, { status: 409, headers });
}
