/**
 * Gives (or takes away) an account the permission to switch on a server's open join link and mark it a public demo.
 * Nobody has it by default. Taking it away switches off every open link on that account's servers straight away.
 * Changes the production database named in .env.local, so it only acts with --yes.
 *
 *   npx tsx --env-file=.env.local scripts/grant-open-links.ts you@example.com            (shows what it would do)
 *   npx tsx --env-file=.env.local scripts/grant-open-links.ts you@example.com --yes      (grants)
 *   npx tsx --env-file=.env.local scripts/grant-open-links.ts you@example.com --revoke --yes
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";

async function main() {
  const email = process.argv[2]?.toLowerCase();
  if (!email || email.startsWith("--")) throw new Error("Usage: grant-open-links.ts <email> [--revoke] [--yes]");
  const revoke = process.argv.includes("--revoke");
  const [account] = await db.select().from(profiles).where(eq(profiles.email, email)).limit(1);
  if (!account) throw new Error(`No account with the email ${email}.`);
  if (account.isGuest) throw new Error("That is a guest account.");
  const want = !revoke;
  console.log(`${account.email} (${account.id}): open-link permission is ${account.canManageOpenLinks ? "ON" : "off"}; would set it ${want ? "ON" : "off"}.`);
  if (account.canManageOpenLinks === want) return console.log("Nothing to change.");
  if (!process.argv.includes("--yes")) return console.log("Dry run. Add --yes to apply.");
  await db.update(profiles).set({ canManageOpenLinks: want }).where(eq(profiles.id, account.id));
  console.log("Done.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
);
