/** Shared plumbing for the playlist route handlers (kept here so the routes stay thin). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { checkRateLimit } from "@/lib/rate-limit";
import type { Failure, Result } from "./results";

export const uuid = z.string().uuid();
export const isUuid = (v: string) => uuid.safeParse(v).success;

export const playlistName = z.string().trim().min(1, "Give it a name").max(100, "Names can be up to 100 characters");
export const playlistDescription = z.string().trim().max(500, "Descriptions can be up to 500 characters").nullable();

const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404 });
export const notFound = NOT_FOUND;

export type Actor = { accountId: string; viewerId: string };

/**
 * Who is acting: signed out => 401; signed in but no profile chosen yet => 403
 * `viewer_required` (as the profile routes do). The viewer id always comes from
 * the session, never from the request.
 */
export async function requireActor(): Promise<{ actor: Actor } | { response: NextResponse }> {
  const resolved = await getCurrentViewer();
  if (!resolved) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!resolved.viewer) return { response: NextResponse.json({ error: "viewer_required" }, { status: 403 }) };
  return { actor: { accountId: resolved.account.id, viewerId: resolved.viewer.id } };
}

/** 429 response when the account is over its request budget for `bucket`, else null. */
export async function throttled(accountId: string, bucket: string, limit: number, windowSeconds: number) {
  const within = await checkRateLimit(accountId, bucket, limit, windowSeconds);
  return within ? null : NextResponse.json({ error: "Too many requests — slow down a little." }, { status: 429 });
}

export function failure(f: Failure) {
  return NextResponse.json({ error: f.error }, { status: f.status });
}

/** Maps a service Result to JSON: failures keep their status, successes pass through `map`. */
export function respond<T, U = T>(result: Result<T>, map?: (value: T) => U, status = 200) {
  return result.ok ? NextResponse.json(map ? map(result.value) : result.value, { status }) : failure(result);
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

export function badRequest(error: z.ZodError | string) {
  const message = typeof error === "string" ? error : (error.issues[0]?.message ?? "Invalid request");
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Opaque, URL-safe pagination cursors. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(raw: string | null, schema: z.ZodType<T>): T | null | "invalid" {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : "invalid";
  } catch {
    return "invalid";
  }
}

export function limitParam(raw: string | null, fallback = 50): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 100) : fallback;
}
