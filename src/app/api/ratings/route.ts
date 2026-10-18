import { NextResponse } from "next/server";
import { afterResponse } from "@/lib/after-response";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { setRating } from "@/lib/ratings/service";
import { pushRating } from "@/lib/trakt/service";
import { json, notFound, readJson, uuid } from "@/lib/ownership/http";

const body = z
  .object({
    kind: z.enum(["title", "episode", "album"]),
    id: uuid,
    /** 1 to 10 half stars (2 is one star), or null to clear the rating. */
    halfStars: z.number().int().min(1).max(10).nullable(),
  })
  .strict();

/** Rates a title, episode or album for the signed-in profile (or clears the rating). Only that profile sees it. */
export async function PUT(request: Request) {
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const result = await setRating(data);
  if (!result.ok) return result.status === 403 ? json({ error: "Forbidden" }, 403) : notFound();
  // A profile connected to Trakt has the rating sent there too (after the answer, best effort).
  if (data.halfStars !== null && data.kind !== "album") {
    const { kind, id, halfStars } = data;
    afterResponse(() => pushRating(db, result.viewerId, kind, id, halfStars));
  }
  return json({ ok: true, halfStars: data.halfStars });
}
