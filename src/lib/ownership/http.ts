import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { playUnitFor, type PlayUnit } from "@/lib/ownership/sessions";
import type { ServerMembership } from "@/lib/auth/guards";
import type { TitleKind } from "@/lib/db/schema";
import { seasons } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export const notFound = () => json({ error: "Not found" }, 404);
export const uuid = z.string().uuid();
export const ALL_KINDS: readonly TitleKind[] = ["movie", "show", "audiobook", "photo", "ebook"];

export async function readJson<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T> | NextResponse> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "Expected JSON" }, 415);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  return parsed.success ? parsed.data : json({ error: "Invalid request" }, 400);
}

export type MemberOfTitle = { member: ServerMembership; serverId: string; unit: PlayUnit };

/**
 * A member who may see this title (membership, age limit, library access: the same gate as playing it). A profile limited by a
 * parent can look but not claim or withdraw, since ownership belongs to the household.
 */
export async function memberOfTitle(titleId: string, opts: { forbidLimited: boolean }): Promise<MemberOfTitle | NextResponse> {
  if (!uuid.safeParse(titleId).success) return notFound();
  const auth = await authorizeOwner("title", titleId, { titleKinds: ALL_KINDS });
  if (!auth.ok) return notFound();
  if (opts.forbidLimited && auth.member.viewer.role === "limited") return json({ error: "Ask a grown-up to do this from their profile." }, 403);
  const unit = await playUnitFor(db, "title", titleId);
  if (!unit) return notFound();
  return { member: auth.member, serverId: auth.serverId, unit };
}

/** The season has to belong to the show, and a show needs one. Returns the season to use (null for anything but a show). */
export async function unitSeason(titleKind: TitleKind, titleId: string, seasonId: string | null | undefined): Promise<{ ok: true; seasonId: string | null } | { ok: false }> {
  if (titleKind !== "show") return { ok: true, seasonId: null };
  if (!seasonId) return { ok: false };
  const [s] = await db.select({ titleId: seasons.titleId }).from(seasons).where(eq(seasons.id, seasonId)).limit(1);
  return s && s.titleId === titleId ? { ok: true, seasonId } : { ok: false };
}
