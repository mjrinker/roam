import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { viewerLibrarySpeeds } from "@/lib/db/schema";
import { isValidSpeed } from "./speed";

/** The speed this profile's playback starts at in a library, or null for normal speed (also null when the stored value isn't an allowed speed). */
export async function viewerLibrarySpeed(viewerId: string, libraryId: string): Promise<number | null> {
  const [row] = await db
    .select({ speed: viewerLibrarySpeeds.speed })
    .from(viewerLibrarySpeeds)
    .where(and(eq(viewerLibrarySpeeds.viewerId, viewerId), eq(viewerLibrarySpeeds.libraryId, libraryId)))
    .limit(1);
  return row && isValidSpeed(row.speed) ? row.speed : null;
}
