import { cookies } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redirectTo } from "@/lib/tv/http";
import { VIEWER_COOKIE } from "@/lib/viewers/cookie";

/** Only a POST signs out, so a link on another site can't do it. Opening this address in a browser just goes to the TV home. */
export async function GET(request: Request) {
  return redirectTo(request, "/tv");
}

/** Signs this TV out (and forgets the chosen profile). Only this TV's session ends; the person's other devices stay signed in. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete(VIEWER_COOKIE);
  return redirectTo(request, "/tv/pair");
}
