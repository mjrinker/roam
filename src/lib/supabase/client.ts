import { createBrowserClient } from "@supabase/ssr";

/** Supabase client for use in Client Components. Safe to call repeatedly. */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
