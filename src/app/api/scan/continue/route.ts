import { after, NextResponse } from "next/server";
import { z } from "zod";
import { scanLibrary } from "@/lib/scan/scanner";

// Runs one more scan pass in the background, in its own function invocation
// (and so its own time budget), when the previous pass stopped early.
export const maxDuration = 60;

const bodySchema = z.object({
  libraryId: z.string().uuid(),
  depth: z.number().int().min(0),
});

/** Internal: chains the next pass of an incomplete scan. Authenticated with CRON_SECRET, like the cron route. */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { libraryId, depth } = parsed.data;

  after(() =>
    scanLibrary(libraryId, "resume", depth).catch((err) => {
      console.error(`Chained scan failed for library ${libraryId}:`, err);
    })
  );
  return NextResponse.json({ accepted: true }, { status: 202 });
}
