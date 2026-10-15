import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { addEvidence, MAX_EVIDENCE_CHARS } from "@/lib/ownership/owners";
import { json, notFound, readJson, uuid } from "@/lib/ownership/http";

const body = z.object({ contentType: z.string().max(40), dataBase64: z.string().max(MAX_EVIDENCE_CHARS) }).strict();

/** The person who made a claim sends a picture the admin asked for. */
export async function POST(request: Request, ctx: RouteContext<"/api/ownership/claims/[claimId]/evidence">) {
  const { claimId } = await ctx.params;
  if (!uuid.safeParse(claimId).success) return notFound();
  const who = await getCurrentViewer();
  if (!who?.viewer) return json({ error: "Unauthorized" }, 401);
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const result = await addEvidence(db, { claimId, accountId: who.account.id, ...data });
  if (result === "ok") return json({ ok: true });
  if (result === "not_requested") return notFound();
  return json({ error: result === "too_many" ? "That's the most pictures you can send." : "That doesn't look like a usable picture (a JPEG, PNG or WebP, shrunk to fit)." }, 400);
}
