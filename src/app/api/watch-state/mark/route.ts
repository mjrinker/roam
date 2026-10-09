import { NextResponse } from "next/server";
import { z } from "zod";
import { markDone } from "@/lib/watch/service";

const bodySchema = z.object({
  kind: z.enum(["title", "episode", "season", "show"]),
  id: z.string().uuid(),
  /** true: mark as watched / listened to / read; false: mark as not. */
  done: z.boolean(),
});

/**
 * Marks a title, episode, season or whole show as done (watched, listened to, read) or not, for the current profile only. The same
 * gate as playing: anything the profile can't see is "not found", and a thing that keeps no place (a picture, a song) can't be marked.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const result = await markDone(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.status === 403 ? "Forbidden" : "Not found" }, { status: result.status });
  return NextResponse.json({ ok: true, count: result.count });
}
