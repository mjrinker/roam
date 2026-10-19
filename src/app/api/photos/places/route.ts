import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { checkRateLimit } from "@/lib/rate-limit";

const headers = { "Cache-Control": "no-store" };

/**
 * Looks a place name up on OpenStreetMap's Nominatim service, for an admin choosing where a photo was taken: `?serverId=…&q=Lake Tahoe`.
 * The text typed is sent to that service, and nothing else (no photo, no account). Nominatim asks for no more than one request a second and an
 * identifying User-Agent; this is only ever one admin typing a search, and is limited well below that. Answers `{ results: [{ latitude, longitude, name }] }`.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const serverId = params.get("serverId") ?? "";
  const q = (params.get("q") ?? "").trim().slice(0, 120);
  if (!z.string().uuid().safeParse(serverId).success || q.length < 2) return NextResponse.json({ results: [] }, { headers });
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  if (!(await checkRateLimit(admin.profile.id, "photo_geocode", 20, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Roam/1.0 (self-hosted media server)", Accept: "application/json" }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res || !res.ok) return NextResponse.json({ error: "The place search isn't answering right now." }, { status: 502, headers });
  const found = (await res.json().catch(() => [])) as { lat?: string; lon?: string; display_name?: string }[];
  const results = (Array.isArray(found) ? found : [])
    .map((r) => ({ latitude: Number(r.lat), longitude: Number(r.lon), name: String(r.display_name ?? "").slice(0, 200) }))
    .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && Math.abs(r.latitude) <= 90 && Math.abs(r.longitude) <= 180);
  return NextResponse.json({ results }, { headers });
}
