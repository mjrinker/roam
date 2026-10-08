import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { setJoinLink } from "@/lib/auth/join";

const bodySchema = z
  .object({ enabled: z.boolean().optional(), rotate: z.boolean().optional(), demo: z.boolean().optional() })
  .strict();

/**
 * The server admin's controls for its open join link: switch it on or off, replace it, and mark the server as a
 * public demo. Admin only (a non-admin, a non-member and a missing server all get the same answer), and a JSON
 * body is required, so a form posted from another site can't change it.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/servers/[serverId]/join-link">) {
  const { serverId } = await ctx.params;
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!z.string().uuid().safeParse(serverId).success) return notFound();
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Expected JSON" }, { status: 415 });

  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) return notFound();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const result = await setJoinLink(serverId, parsed.data);
  if (!result) return notFound();
  return NextResponse.json({ joinToken: result.joinToken, isDemo: result.isDemo }, { headers: { "Cache-Control": "no-store" } });
}
