import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/auth/guards";
import { createServer } from "@/lib/auth/servers";

const bodySchema = z.object({ name: z.string().min(1).max(100) });

/** Any signed-in profile can create a server (capped per-user — see createServer). */
export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await createServer(profile.id, parsed.data.name);
  if (!result.ok) {
    return NextResponse.json(
      { error: "You've reached the limit on servers you can create." },
      { status: 429 }
    );
  }

  return NextResponse.json({ server: result.server });
}
