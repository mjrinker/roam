import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";

/** The profile in use as stored (its PIN hash and PIN version, which the page checks and nothing else is shown). */
export async function getViewerRow(id: string) {
  const [row] = await db.select().from(viewers).where(eq(viewers.id, id)).limit(1);
  return row ?? null;
}
