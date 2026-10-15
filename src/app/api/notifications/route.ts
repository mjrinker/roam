import { db } from "@/lib/db/client";
import { getCurrentProfile } from "@/lib/auth/guards";
import { listNotifications, unreadCount } from "@/lib/ownership/notify";
import { sweepForWatcher } from "@/lib/ownership/sessions";
import { json } from "@/lib/ownership/http";

/** The signed-in account's notifications, newest first, and how many are unread. */
export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile) return json({ error: "Unauthorized" }, 401);
  await sweepForWatcher(db, profile.id); // a player that went quiet frees its copy, and whoever waited for it hears now
  const [items, unread] = await Promise.all([listNotifications(db, profile.id), unreadCount(db, profile.id)]);
  return json({ unread, items: items.map((n) => ({ id: n.id, kind: n.kind, message: n.message, href: n.href, createdAt: n.createdAt, read: !!n.readAt })) });
}
