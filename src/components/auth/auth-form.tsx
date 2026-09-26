"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AuthFormProps {
  /** "invite" locks the email field to the invited address; "sign-in" is the general entry point (open sign-up). */
  mode: "sign-in" | "invite";
  initialEmail?: string;
  /** Carried through the whole auth flow so the right invite gets redeemed once signed in. */
  inviteToken?: string;
}

const INVITE_ERROR_MESSAGES: Record<string, string> = {
  "invite-not-found": "That invite link is invalid or has expired.",
  "invite-email-mismatch": "That invite was sent to a different email address.",
};

async function completeSignIn(
  router: ReturnType<typeof useRouter>,
  inviteToken?: string
) {
  const res = await fetch("/api/auth/ensure-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteToken }),
  });
  if (!res.ok) {
    toast.error("Something went wrong signing you in.");
    return;
  }
  const body: { redirectTo: string; error?: string } = await res.json();
  if (body.error) {
    toast.error(INVITE_ERROR_MESSAGES[body.error] ?? "Something went wrong.");
  } else {
    toast.success("Signed in.");
  }
  router.push(body.redirectTo);
  router.refresh();
}

export function AuthForm({ mode, initialEmail = "", inviteToken }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  // Sign-up is open to anyone; "sign-in" mode defaults to returning-user
  // sign-in but can toggle to create-account. "invite" mode is always
  // create-account, with the email locked to the invited address.
  const [creatingAccount, setCreatingAccount] = useState(mode === "invite");

  const supabase = createSupabaseBrowserClient();
  const callbackUrl = new URL(`${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`);
  if (inviteToken) callbackUrl.searchParams.set("invite_token", inviteToken);
  const redirectTo = callbackUrl.toString();

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading("magic-link");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    setLoading(null);
    if (error) toast.error(error.message);
    else toast.success("Check your email for a sign-in link.");
  }

  async function handleGoogle() {
    setLoading("google");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) {
      setLoading(null);
      toast.error(error.message);
    }
    // On success the browser navigates away to Google, so no further state change here.
  }

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading("password");

    if (creatingAccount) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setLoading(null);
        toast.error(error.message);
        return;
      }
      if (!data.session) {
        setLoading(null);
        toast.success("Check your email to confirm your account, then sign in.");
        return;
      }
      await completeSignIn(router, inviteToken);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setLoading(null);
        toast.error(error.message);
        return;
      }
      await completeSignIn(router, inviteToken);
    }
    setLoading(null);
  }

  const inputClass = "h-11 rounded-xl bg-white/[0.05] px-3.5";
  const submitClass = "h-11 w-full rounded-xl text-[15px] font-semibold";

  return (
    <div className="flex w-full flex-col gap-5">
      <Button
        type="button"
        onClick={handleGoogle}
        disabled={loading === "google"}
        className="h-11 w-full gap-3 rounded-xl bg-white text-[15px] font-semibold text-neutral-900 hover:bg-white/90"
      >
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z" />
          <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24Z" />
          <path fill="#FBBC05" d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.28a12 12 0 0 0 0 10.78l4.01-3.1Z" />
          <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.23 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.1C6.23 6.86 8.88 4.75 12 4.75Z" />
        </svg>
        {loading === "google" ? "Redirecting…" : "Continue with Google"}
      </Button>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-white/10" />
        or use your email
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <Tabs defaultValue="magic-link" className="w-full">
        <TabsList className="grid h-10 w-full grid-cols-2 rounded-xl bg-white/[0.05] p-1">
          <TabsTrigger value="magic-link" className="rounded-lg">
            Email link
          </TabsTrigger>
          <TabsTrigger value="password" className="rounded-lg">
            Password
          </TabsTrigger>
        </TabsList>

        <TabsContent value="magic-link" className="mt-4">
          <form onSubmit={handleMagicLink} className="flex flex-col gap-3.5">
            <div className="grid gap-1.5">
              <Label htmlFor="email-link">Email</Label>
              <Input
                id="email-link"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                disabled={mode === "invite"}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </div>
            <Button type="submit" disabled={loading === "magic-link"} className={submitClass}>
              {loading === "magic-link" ? "Sending…" : "Send me a sign-in link"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              No password needed — we&apos;ll email you a one-tap link.
            </p>
          </form>
        </TabsContent>

        <TabsContent value="password" className="mt-4">
          <form onSubmit={handlePassword} className="flex flex-col gap-3.5">
            <div className="grid gap-1.5">
              <Label htmlFor="email-pw">Email</Label>
              <Input
                id="email-pw"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                disabled={mode === "invite"}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
            </div>
            <Button type="submit" disabled={loading === "password"} className={submitClass}>
              {loading === "password"
                ? "Please wait…"
                : creatingAccount
                  ? "Create account"
                  : "Sign in"}
            </Button>
            {mode === "sign-in" && (
              <button
                type="button"
                onClick={() => setCreatingAccount((c) => !c)}
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {creatingAccount
                  ? "Already have an account? Sign in"
                  : "Don't have an account? Create one"}
              </button>
            )}
          </form>
        </TabsContent>
      </Tabs>
    </div>
  );
}
