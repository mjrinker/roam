import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { submitClaim } from "@/lib/ownership/owners";
import { checkRateLimit } from "@/lib/rate-limit";
import { json, memberOfTitle, notFound, readJson, unitSeason, uuid } from "@/lib/ownership/http";

const body = z.object({ titleId: uuid, seasonId: uuid.nullish() }).strict();

/** A member says they own a copy (of a movie, book or album, or of one season of a show). Settled at once or left for the admin. */
export async function POST(request: Request) {
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const m = await memberOfTitle(data.titleId, { forbidLimited: true });
  if (m instanceof NextResponse) return m;
  if (!(await checkRateLimit(m.member.profile.id, "ownership_claim", 60, 3600))) return json({ error: "Too many claims; try again later." }, 429);
  const season = await unitSeason(m.unit.titleKind, data.titleId, data.seasonId);
  if (!season.ok) return notFound();
  const result = await submitClaim(db, { titleId: data.titleId, seasonId: season.seasonId, accountId: m.member.profile.id });
  if (result.status === "not_found") return notFound();
  if (result.status === "disabled") return json({ error: "This server doesn't track who owns what." }, 409);
  return json(result);
}
