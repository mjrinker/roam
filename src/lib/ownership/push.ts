/** Web push: a notification on the phone or desktop, from a browser that agreed to it. Does nothing when the keys aren't set. */
import { eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import webpush from "web-push";
import { pushSubscriptions } from "@/lib/db/schema";
import { sendFcmTo } from "@/lib/push/fcm";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The key the browser needs to subscribe, or null when push isn't set up on this deployment. */
export function pushPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PUBLIC_KEY : null;
}

export interface PushPayload {
  title: string;
  body: string;
  href: string | null;
}

/** Sends to every browser the account has allowed. A browser that is gone for good is forgotten; any other failure is ignored. */
export async function sendPushTo(ex: Db, accountId: string, payload: PushPayload): Promise<void> {
  await sendFcmTo(ex, accountId, payload).catch(() => undefined); // the account's apps, if push to apps is set up
  const publicKey = pushPublicKey();
  if (!publicKey) return;
  const subs = await ex.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId));
  if (subs.length === 0) return;
  const gone: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
          vapidDetails: { subject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", publicKey, privateKey: process.env.VAPID_PRIVATE_KEY! },
          TTL: 3600,
          timeout: 5000,
        });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(s.id);
      }
    })
  );
  if (gone.length) await ex.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
}

export async function saveSubscription(ex: Db, accountId: string, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
  await ex
    .insert(pushSubscriptions)
    .values({ accountId, ...sub })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { accountId, p256dh: sub.p256dh, auth: sub.auth } });
}

export async function removeSubscription(ex: Db, accountId: string, endpoint: string): Promise<void> {
  const rows = await ex.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  if (rows.some((r) => r.accountId === accountId)) await ex.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}
