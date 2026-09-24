import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentAdminProfile } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";

const bodySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["movies", "shows"]),
  boxFolderId: z.string().min(1),
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

  const [library] = await db.insert(libraries).values(parsed.data).returning();
  return NextResponse.json({ library });
}
