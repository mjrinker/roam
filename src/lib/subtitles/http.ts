/** What the subtitle routes share: who may see or change an item's subtitles, and how OpenSubtitles problems are reported. */
import { NextResponse } from "next/server";
import { authorizeOwner, type OwnerAuthorization } from "@/lib/auth/resolve-server";
import { libraryHasDoneState } from "@/lib/libraries/profile";
import { OpenSubtitlesError } from "./opensubtitles";
import type { SubtitleOwner } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An owner from request parameters, or null when they are not well formed. */
export function parseOwner(kind: unknown, id: unknown): SubtitleOwner | null {
  return (kind === "title" || kind === "episode") && typeof id === "string" && UUID.test(id) ? { kind, id } : null;
}

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export type SubtitleAccess = { ok: true; auth: Extract<OwnerAuthorization, { ok: true }>; isAdmin: boolean } | { ok: false; response: NextResponse };

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Whether the signed-in profile may see this movie, video or episode (the same gate as playing it) and whether it is the server's admin.
 * Anything it can't see is the same 404 as one that doesn't exist; pictures and clips beside them have no subtitles.
 */
export async function authorizeSubtitles(owner: SubtitleOwner, opts: { admin?: boolean } = {}): Promise<SubtitleAccess> {
  const auth = owner.kind === "title" ? await authorizeOwner("title", owner.id, { titleKinds: ["movie"] }) : await authorizeOwner("episode", owner.id);
  if (!auth.ok || !libraryHasDoneState(auth.libraryKind) || auth.libraryKind === "music" || auth.libraryKind === "ebooks") return { ok: false, response: notFound() };
  const isAdmin = auth.member.role === "admin" && auth.member.viewer.role !== "limited";
  // A viewer who is not the admin learns nothing from a refusal: the same 404.
  if (opts.admin && !isAdmin) return { ok: false, response: notFound() };
  return { ok: true, auth, isAdmin };
}

/** An OpenSubtitles problem as a response the admin can read. */
export function openSubtitlesFailure(error: unknown): NextResponse {
  if (error instanceof OpenSubtitlesError) {
    const status = error.kind === "not_found" ? 404 : error.kind === "quota" || error.kind === "rate" ? 429 : error.kind === "not_configured" ? 503 : 502;
    return NextResponse.json({ error: error.message, kind: error.kind }, { status, headers: error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : undefined });
  }
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}
