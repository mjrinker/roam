import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { isValidSpeed } from "./speed";

/** The speed a library's playback starts at, or null for normal speed (also null for a missing library or a stored value that isn't allowed). */
export async function libraryDefaultSpeed(libraryId: string): Promise<number | null> {
  const [row] = await db.select({ speed: libraries.defaultPlaybackSpeed }).from(libraries).where(eq(libraries.id, libraryId)).limit(1);
  return row && isValidSpeed(row.speed) ? row.speed : null;
}
