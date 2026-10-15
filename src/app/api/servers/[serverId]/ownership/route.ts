import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { saveSettings } from "@/lib/ownership/owners";
import { OWNABLE_LIBRARY_KINDS } from "@/lib/libraries/profile";
import { json, notFound, readJson, uuid } from "@/lib/ownership/http";

// Music and photos aren't owned copies of a title, so the limit never covers them.
const KINDS = OWNABLE_LIBRARY_KINDS;
const body = z
  .object({
    enabled: z.boolean().optional(),
    claimMode: z.enum(["instant", "review"]).optional(),
    limitConcurrent: z.boolean().optional(),
    limitKinds: z.array(z.enum(KINDS)).max(KINDS.length).optional(),
  })
  .strict();

/** The server admin's choices: whether ownership is tracked, how a claim is settled, and whether playing at once is limited (and for which libraries). */
export async function PUT(request: Request, ctx: RouteContext<"/api/servers/[serverId]/ownership">) {
  const { serverId } = await ctx.params;
  if (!uuid.safeParse(serverId).success || !(await getCurrentServerAdmin(serverId))) return notFound();
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  return json(await saveSettings(db, serverId, { ...data, limitKinds: data.limitKinds ? [...new Set(data.limitKinds)] : undefined }));
}
