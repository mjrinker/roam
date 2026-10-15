import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { removeOwner, setShared } from "@/lib/ownership/owners";
import { announceFreed } from "@/lib/ownership/sessions";
import { json, memberOfTitle, notFound, readJson, unitSeason, uuid } from "@/lib/ownership/http";

const put = z.object({ titleId: uuid, seasonId: uuid.nullish(), shared: z.boolean() }).strict();
const del = z.object({ titleId: uuid, seasonId: uuid.nullish() }).strict();

async function resolve(titleId: string, seasonId: string | null | undefined) {
  const m = await memberOfTitle(titleId, { forbidLimited: true });
  if (m instanceof NextResponse) return m;
  const season = await unitSeason(m.unit.titleKind, titleId, seasonId);
  if (!season.ok) return notFound();
  return { m, unit: { titleId, seasonId: season.seasonId } };
}

/** An owner withdraws their copy (nobody else can play it, if there's no other shared copy) or shares it with the whole server again. */
export async function PUT(request: Request) {
  const data = await readJson(request, put);
  if (data instanceof NextResponse) return data;
  const r = await resolve(data.titleId, data.seasonId);
  if (r instanceof NextResponse) return r;
  const ok = await setShared(db, r.unit, r.m.member.profile.id, data.shared);
  if (!ok) return json({ error: "You don't own this." }, 409);
  if (data.shared) await announceFreed(db, r.unit);
  return json({ shared: data.shared });
}

/** An owner gives up their claim to own it. */
export async function DELETE(request: Request) {
  const data = await readJson(request, del);
  if (data instanceof NextResponse) return data;
  const r = await resolve(data.titleId, data.seasonId);
  if (r instanceof NextResponse) return r;
  await removeOwner(db, r.unit, r.m.member.profile.id);
  return json({ ok: true });
}
