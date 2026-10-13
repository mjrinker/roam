/**
 * The ledger of outside accounts linked to Roam (provider_accounts), and unlinking them when their last connection goes. Some services
 * cap how many accounts an unapproved app may link, so what counts is accounts, not connections: one Dropbox account on two servers is
 * one account, and removing the second connection must not unlink the first.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { decrypt } from "@/lib/crypto";
import { providerAccounts, storageConnections, type StorageProviderKind } from "@/lib/db/schema";
import { dropboxRefresher, dropboxRevoke } from "@/lib/storage/dropbox";
import { googleRevoke } from "@/lib/storage/google-drive";
import { accessTokenFor } from "@/lib/storage/oauth-tokens";

const keyOf = (name: string) => name.trim().toLowerCase();

/** Notes that this outside account is linked (now), starting or reviving its entry in the ledger. */
export async function recordProviderAccount(provider: StorageProviderKind, accountName: string | null | undefined): Promise<void> {
  if (!accountName || provider === "box") return;
  await db
    .insert(providerAccounts)
    .values({ provider, accountKey: keyOf(accountName), label: accountName.trim() })
    .onConflictDoUpdate({ target: [providerAccounts.provider, providerAccounts.accountKey], set: { lastConnectedAt: new Date(), revokedAt: null, label: accountName.trim() } });
}

type Conn = typeof storageConnections.$inferSelect;

async function revokeAtProvider(conn: Conn): Promise<void> {
  if (conn.provider === "dropbox") await dropboxRevoke(await accessTokenFor(conn.id, dropboxRefresher));
  else if (conn.provider === "gdrive" && conn.refreshTokenEncrypted) await googleRevoke(decrypt(conn.refreshTokenEncrypted));
  // Microsoft has no way for an app to revoke its own delegated token; the person does it in their account's app permissions.
}

/**
 * Call BEFORE deleting these connections. For each outside account that no other connection (on any server) still uses, unlinks it at the
 * provider (best effort: a failure never blocks the removal) and marks it revoked in the ledger. Returns how many accounts were unlinked.
 */
export async function releaseConnections(connectionIds: string[]): Promise<number> {
  if (connectionIds.length === 0) return 0;
  const going = await db.select().from(storageConnections).where(inArray(storageConnections.id, connectionIds));
  let released = 0;
  const done = new Set<string>();
  for (const conn of going) {
    if (!conn.accountName || conn.provider === "box") continue;
    const key = `${conn.provider}:${keyOf(conn.accountName)}`;
    if (done.has(key)) continue;
    done.add(key);
    const [stillUsed] = await db
      .select({ id: storageConnections.id })
      .from(storageConnections)
      .where(and(eq(storageConnections.provider, conn.provider), sql`lower(${storageConnections.accountName}) = ${keyOf(conn.accountName)}`, sql`${storageConnections.id} NOT IN (${sql.join(connectionIds.map((i) => sql`${i}`), sql`, `)})`, ne(storageConnections.id, conn.id)))
      .limit(1);
    if (stillUsed) continue;
    try {
      await revokeAtProvider(conn);
    } catch (err) {
      console.warn(`Couldn't unlink ${conn.provider} account ${conn.accountName}: ${(err as Error).message}`);
      continue;
    }
    await db.update(providerAccounts).set({ revokedAt: new Date() }).where(and(eq(providerAccounts.provider, conn.provider), eq(providerAccounts.accountKey, keyOf(conn.accountName))));
    released++;
  }
  return released;
}
