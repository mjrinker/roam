/**
 * Lets an account open the platform admin page (/platform) - numbers and health for every server. Run by hand, once, for the account
 * that runs the platform. `--revoke` takes it away.
 *
 *   npx tsx --env-file=.env.local scripts/grant-platform-admin.ts you@example.com
 *   npx tsx --env-file=.env.local scripts/grant-platform-admin.ts you@example.com --revoke
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const revoke = process.argv.includes("--revoke");
  if (!email || email.startsWith("--")) throw new Error("Give the account's email address.");
  const rows = await db.update(profiles).set({ isPlatformAdmin: !revoke }).where(eq(profiles.email, email)).returning({ id: profiles.id });
  if (rows.length === 0) throw new Error(`No account with the email ${email}. It must have signed in to Roam at least once.`);
  console.log(`${email} ${revoke ? "can no longer open" : "can now open"} the platform admin page.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
