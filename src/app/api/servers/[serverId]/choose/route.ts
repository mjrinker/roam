import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { choosableLibraries } from "@/lib/choose/libraries";
import { pickRandomItems } from "@/lib/choose/pick";
import { checkRateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  libraryIds: z.array(z.string().uuid()).min(1).max(30),
  /** Items already shown this time, which are not offered again. */
  exclude: z.array(z.string().uuid()).max(500).default([]),
  count: z.number().int().min(1).max(2).default(2),
});

/**
 * Random things to choose between from the libraries selected ("Help me choose"). Only libraries this profile can see are used, and
 * the same age limit applies as when browsing; anything else is just not offered. `items` may be fewer than asked for when the libraries
 * run out.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/servers/[serverId]/choose">) {
  const { serverId } = await ctx.params;
  const member = await getCurrentServerMember(serverId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send libraryIds (1 to 30), and optionally exclude and count." }, { status: 400 });
  if (!(await checkRateLimit(member.profile.id, "choose", 240, 60))) return NextResponse.json({ error: "Too many requests: try again in a minute." }, { status: 429 });

  const actor = libraryActor(member, serverId);
  const chosen = await choosableLibraries(db, actor, parsed.data.libraryIds);
  const items = await pickRandomItems(db, { actor, viewer: member.viewer, viewerId: member.viewer.id, libraries: chosen, exclude: parsed.data.exclude, count: parsed.data.count });
  return NextResponse.json({ items, libraries: chosen.length }, { headers: { "Cache-Control": "no-store" } });
}
