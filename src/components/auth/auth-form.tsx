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
  /** "invite" locks the email field and creates a new password account; "sign-in" is for returning users. */
  mode: "sign-in" | "invite";
  initialEmail?: string;
}

async function bindInvitedProfileOrSignOut(router: ReturnType<typeof useRouter>) {
  const res = await fetch("/api/auth/ensure-profile", { method: "POST" });
  if (!res.ok) {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    const body = await res.json().catch(() => ({}));
    toast.error(body.error ?? "This account hasn't been invited.");
    return;
  }
  toast.success("Signed in.");
  router.push("/library");
  router.refresh();
}

export function AuthForm({ mode, initialEmail = "" }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState<string | null>(null);

  const supabase = createSupabaseBrowserClient();
  const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`;

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

    if (mode === "invite") {
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
      await bindInvitedProfileOrSignOut(router);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setLoading(null);
        toast.error(error.message);
        return;
      }
      await bindInvitedProfileOrSignOut(router);
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
              : mode === "invite"
                ? "Create account"
                : "Sign in"}
          </Button>
        </form>
      </TabsContent>
    </Tabs>
  );
}
