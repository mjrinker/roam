import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { createInvite } from "@/lib/auth/invites";
import { db } from "@/lib/db/client";
import { invites } from "@/lib/db/schema";

const bodySchema = z.object({
  serverId: z.string().uuid(),
  email: z.string().email(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const admin = await getCurrentServerAdmin(parsed.data.serverId);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await createInvite(parsed.data.email, parsed.data.serverId, admin.profile.id);
  if (result.error) {
    const message =
      result.error === "rate_limited"
        ? "Too many invites sent — try again in a bit."
        : "This server has too many pending invites already.";
    return NextResponse.json({ error: message }, { status: 429 });
  }

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/${result.invite.token}`;
  return NextResponse.json({ invite: result.invite, inviteUrl });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  if (!serverId) {
    return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  }

  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const all = await db
    .select()
    .from(invites)
    .where(eq(invites.serverId, serverId))
    .orderBy(desc(invites.createdAt));
  return NextResponse.json({ invites: all });
}
