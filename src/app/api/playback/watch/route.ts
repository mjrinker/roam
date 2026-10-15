import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { stopWatching, watchForAvailability } from "@/lib/ownership/sessions";
import { json, memberOfTitle, notFound, readJson, unitSeason, uuid } from "@/lib/ownership/http";

const body = z.object({ titleId: uuid, seasonId: uuid.nullish() }).strict();

async function resolve(request: Request) {
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const m = await memberOfTitle(data.titleId, { forbidLimited: false });
  if (m instanceof NextResponse) return m;
  const season = await unitSeason(m.unit.titleKind, data.titleId, data.seasonId);
  if (!season.ok) return notFound();
  return { m, unit: { titleId: data.titleId, seasonId: season.seasonId } };
}

/** "Tell me when a copy is free." */
export async function PUT(request: Request) {
  const r = await resolve(request);
  if (r instanceof NextResponse) return r;
  await watchForAvailability(db, r.unit, { viewerId: r.m.member.viewer.id, accountId: r.m.member.profile.id });
  return json({ watching: true });
}

export async function DELETE(request: Request) {
  const r = await resolve(request);
  if (r instanceof NextResponse) return r;
  await stopWatching(db, r.unit, r.m.member.viewer.id);
  return json({ watching: false });
}
