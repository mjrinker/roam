import { db } from "@/lib/db/client";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { endPlay } from "@/lib/ownership/sessions";
import { json } from "@/lib/ownership/http";

/** A player closed (also sent as a beacon when the page goes away): lets go of its place. Only ever affects the caller's own. */
export async function POST() {
  const who = await getCurrentViewer();
  if (!who?.viewer) return json({ ok: true });
  await endPlay(db, who.viewer.id);
  return json({ ok: true });
}
