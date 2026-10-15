import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { ownershipEvidence } from "@/lib/db/schema";
import { serverOfClaim } from "@/lib/ownership/owners";
import { notFound, uuid } from "@/lib/ownership/http";

/** One of the pictures sent as evidence, for the server's admin only. */
export async function GET(_request: Request, ctx: RouteContext<"/api/ownership/claims/[claimId]/pictures/[pictureId]">) {
  const { claimId, pictureId } = await ctx.params;
  if (!uuid.safeParse(claimId).success || !uuid.safeParse(pictureId).success) return notFound();
  const serverId = await serverOfClaim(db, claimId);
  if (!serverId || !(await getCurrentServerAdmin(serverId))) return notFound();
  const [pic] = await db.select().from(ownershipEvidence).where(and(eq(ownershipEvidence.id, pictureId), eq(ownershipEvidence.claimId, claimId))).limit(1);
  if (!pic) return notFound();
  return new Response(Buffer.from(pic.dataBase64, "base64"), {
    headers: { "Content-Type": pic.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
  });
}
