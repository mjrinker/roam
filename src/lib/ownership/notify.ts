/** In-app notifications (the bell), and the push that carries them to a phone or desktop when the person has allowed it. */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { notifications, serverMembers, type NotificationKind } from "@/lib/db/schema";
import { sendPushTo } from "@/lib/ownership/push";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface NewNotification {
  accountId: string;
  serverId: string | null;
  kind: NotificationKind;
  titleId?: string | null;
  message: string;
  href?: string | null;
}

/** Records a notification and, if push is set up and the person allowed it, sends it too (a failure to push never loses the notification). */
export async function notify(ex: Db, n: NewNotification): Promise<void> {
  await ex.insert(notifications).values({ accountId: n.accountId, serverId: n.serverId, kind: n.kind, titleId: n.titleId ?? null, message: n.message, href: n.href ?? null });
  await sendPushTo(ex, n.accountId, { title: "Roam", body: n.message, href: n.href ?? null }).catch(() => undefined);
}

/** The accounts that run a server (its admin). */
export async function serverAdminAccounts(ex: Db, serverId: string): Promise<string[]> {
  const rows = await ex.select({ id: serverMembers.profileId }).from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.role, "admin")));
  return rows.map((r) => r.id);
}

export async function notifyAdmins(ex: Db, serverId: string, n: Omit<NewNotification, "accountId" | "serverId">): Promise<void> {
  for (const accountId of await serverAdminAccounts(ex, serverId)) await notify(ex, { ...n, accountId, serverId });
}

export async function listNotifications(ex: Db, accountId: string, limit = 30) {
  return ex.select().from(notifications).where(eq(notifications.accountId, accountId)).orderBy(desc(notifications.createdAt)).limit(limit);
}

export async function unreadCount(ex: Db, accountId: string): Promise<number> {
  const [row] = await ex.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** Marks one notification, or all of an account's, as read. */
export async function markRead(ex: Db, accountId: string, id?: string): Promise<void> {
  await ex
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt), ...(id ? [eq(notifications.id, id)] : [])));
}
