import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentAdminProfile } from "@/lib/auth/guards";
import { createInvite } from "@/lib/auth/invites";
import { db } from "@/lib/db/client";
import { invites } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

const bodySchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "viewer"]).default("viewer"),
});

export async function POST(request: Request) {
  const admin = await getCurrentAdminProfile();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const invite = await createInvite(parsed.data.email, parsed.data.role, admin.id);
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/${invite.token}`;

  return NextResponse.json({ invite, inviteUrl });
}

export async function GET() {
  const admin = await getCurrentAdminProfile();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const all = await db.select().from(invites).orderBy(desc(invites.createdAt));
  return NextResponse.json({ invites: all });
}
