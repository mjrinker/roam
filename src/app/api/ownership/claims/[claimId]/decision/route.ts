import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { decideClaim, serverOfClaim } from "@/lib/ownership/owners";
import { json, notFound, readJson, uuid } from "@/lib/ownership/http";

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }).strict(),
  z.object({ kind: z.literal("reject"), note: z.string().max(500).optional() }).strict(),
  z.object({ kind: z.literal("evidence"), note: z.string().trim().min(1).max(500) }).strict(),
]);

/** The server's admin approves a claim, turns it down, or asks for evidence. */
export async function POST(request: Request, ctx: RouteContext<"/api/ownership/claims/[claimId]/decision">) {
  const { claimId } = await ctx.params;
  if (!uuid.safeParse(claimId).success) return notFound();
  const serverId = await serverOfClaim(db, claimId);
  if (!serverId || !(await getCurrentServerAdmin(serverId))) return notFound();
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  const ok = await decideClaim(db, { serverId, claimId, decision: data });
  return ok ? json({ ok: true }) : json({ error: "That claim has already been decided." }, 409);
}
