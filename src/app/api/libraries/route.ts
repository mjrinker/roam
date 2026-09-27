import { NextResponse } from "next/server";
import { z } from "zod";
import { count, eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";

const MAX_LIBRARIES_PER_SERVER = Number(process.env.MAX_LIBRARIES_PER_SERVER ?? 5);

const bodySchema = z.object({
  serverId: z.string().uuid(),
  name: z.string().min(1),
  kind: z.enum(["movies", "shows", "audiobooks"]),
  boxFolderId: z.string().min(1),
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

  const [{ existingCount }] = await db
    .select({ existingCount: count() })
    .from(libraries)
    .where(eq(libraries.serverId, parsed.data.serverId));
  if (existingCount >= MAX_LIBRARIES_PER_SERVER) {
    return NextResponse.json(
      { error: "This server has reached its limit on libraries." },
      { status: 429 }
    );
  }

  const [library] = await db.insert(libraries).values(parsed.data).returning();
  return NextResponse.json({ library });
}
