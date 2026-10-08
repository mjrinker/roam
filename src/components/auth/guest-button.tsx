"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { completeSignIn } from "@/components/auth/auth-form";
import { Button } from "@/components/ui/button";
import { useCaptcha } from "@/components/auth/captcha";
import { signInAsGuest } from "@/lib/auth/sign-in-calls";

/** One click into a demo server as an anonymous guest: no email, no password. The server decides it is a guest from the session, not from anything sent here. */
export function GuestButton({ joinToken }: { joinToken: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const captcha = useCaptcha();

  async function enter() {
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    const { error } = await signInAsGuest(supabase.auth, { captcha: captcha.options() });
    captcha.reset(); // a token works once
    if (error) {
      setLoading(false);
      toast.error(/anonymous/i.test(error.message) ? "Guest access isn't switched on yet." : error.message);
      return;
    }
    await completeSignIn(router, undefined, joinToken);
    setLoading(false);
  }

  return (
    <Button type="button" onClick={() => void enter()} disabled={loading || !captcha.ready} className="h-12 w-full rounded-xl text-[15px] font-semibold">
      {loading ? "Setting up your guest pass…" : "Continue as a guest"}
    </Button>
  );
}
