import type { StorageProviderKind } from "@/lib/db/schema";

/** The kinds of storage this deployment is set up for (the app keys they sign in with exist), in the order they are offered. Server only. */
export function availableProviders(env: Record<string, string | undefined> = process.env): StorageProviderKind[] {
  const out: StorageProviderKind[] = [];
  if (env.BOX_CLIENT_ID && env.BOX_CLIENT_SECRET) out.push("box");
  if (env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET) out.push("dropbox");
  return out;
}
