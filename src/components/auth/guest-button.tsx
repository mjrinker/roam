"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { completeSignIn } from "@/components/auth/auth-form";
import { Button } from "@/components/ui/button";

/** One click into a demo server as an anonymous guest: no email, no password. The server decides it is a guest from the session, not from anything sent here. */
export function GuestButton({ joinToken }: { joinToken: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function enter() {
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signInAnonymously();
    if (error) {
      setLoading(false);
      toast.error(/anonymous/i.test(error.message) ? "Guest access isn't switched on yet." : error.message);
      return;
    }
    await completeSignIn(router, undefined, joinToken);
    setLoading(false);
  }

  return (
    <Button type="button" onClick={() => void enter()} disabled={loading} className="h-12 w-full rounded-xl text-[15px] font-semibold">
      {loading ? "Setting up your guest pass…" : "Continue as a guest"}
    </Button>
  );
}
