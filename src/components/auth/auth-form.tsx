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

  return (
    <Tabs defaultValue="magic-link" className="w-full max-w-sm">
      <TabsList className="w-full">
        <TabsTrigger value="magic-link">Email link</TabsTrigger>
        <TabsTrigger value="google">Google</TabsTrigger>
        <TabsTrigger value="password">Password</TabsTrigger>
      </TabsList>

      <TabsContent value="magic-link" className="mt-4">
        <form onSubmit={handleMagicLink} className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="email-link">Email</Label>
            <Input
              id="email-link"
              type="email"
              required
              value={email}
              disabled={mode === "invite"}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={loading === "magic-link"}>
            {loading === "magic-link" ? "Sending…" : "Send sign-in link"}
          </Button>
        </form>
      </TabsContent>

      <TabsContent value="google" className="mt-4">
        <Button onClick={handleGoogle} disabled={loading === "google"} className="w-full">
          {loading === "google" ? "Redirecting…" : "Continue with Google"}
        </Button>
      </TabsContent>

      <TabsContent value="password" className="mt-4">
        <form onSubmit={handlePassword} className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="email-pw">Email</Label>
            <Input
              id="email-pw"
              type="email"
              required
              value={email}
              disabled={mode === "invite"}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={loading === "password"}>
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
              className="text-xs text-muted-foreground underline underline-offset-2"
            >
              {creatingAccount
                ? "Already have an account? Sign in"
                : "Don't have an account? Create one"}
            </button>
          )}
        </form>
      </TabsContent>
    </Tabs>
  );
}
