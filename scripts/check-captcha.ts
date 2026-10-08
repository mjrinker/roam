/**
 * Checks whether CAPTCHA protection is switched on in Supabase, without creating anything: it asks for an anonymous sign-in
 * WITHOUT a token. With protection on, Supabase refuses that ("captcha verification process failed"); with it off, it would
 * sign a guest in, so the script signs that guest out again and tells you protection is OFF. Run from the repo root (reads .env.local):
 *
 *   npx tsx --env-file=.env.local scripts/check-captcha.ts
 *
 * Order matters when turning CAPTCHA on: deploy NEXT_PUBLIC_TURNSTILE_SITE_KEY first, then switch Supabase on, then run this.
 */
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.");
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) {
    if (/captcha/i.test(error.message)) console.log(`CAPTCHA protection is ON in Supabase (a sign-in without a token was refused: "${error.message}").`);
    else console.log(`Could not tell: Supabase refused the sign-in for another reason ("${error.message}"). Anonymous sign-ins may be switched off.`);
    return;
  }
  console.log("CAPTCHA protection is OFF in Supabase: a sign-in with no token succeeded.");
  if (data.session) await supabase.auth.signOut();
  console.log("(That test guest was signed out; it will be removed by the normal inactive-guest cleanup.)");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
