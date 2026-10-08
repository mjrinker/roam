"use client";

import { useState } from "react";
import { Loader2, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";

type Step = { name: "enter" } | { name: "confirm"; deviceLabel: string } | { name: "done"; deviceLabel: string };

/** Approve the code a TV is showing: type it, check which TV it is, confirm. */
export function LinkTvForm({ email }: { email: string }) {
  const [step, setStep] = useState<Step>({ name: "enter" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(approve: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/tv/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, approve }) }).catch(() => null);
    setBusy(false);
    const data = (await res?.json().catch(() => null)) as { deviceLabel?: string; error?: string } | null;
    if (!res || !res.ok || !data) return setError(data?.error ?? "Something went wrong. Try again.");
    setStep(approve ? { name: "done", deviceLabel: data.deviceLabel ?? "TV" } : { name: "confirm", deviceLabel: data.deviceLabel ?? "TV" });
  }

  if (step.name === "done") {
    return (
      <div className="flex flex-col items-center gap-3 text-center" role="status">
        <Tv className="size-10 text-primary" />
        <p className="text-lg font-medium">Your {step.deviceLabel} is signing in.</p>
        <p className="text-sm text-muted-foreground">It will continue on its own in a few seconds. You can close this page.</p>
      </div>
    );
  }
  if (step.name === "confirm") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-base">
          Sign in the <strong>{step.deviceLabel}</strong> showing code <strong className="tracking-widest">{code.toUpperCase()}</strong> as <strong>{email}</strong>?
        </p>
        <p className="rounded-xl bg-amber-400/10 px-4 py-3 text-sm text-amber-100/90 ring-1 ring-amber-400/20">
          Only approve this if you are looking at that code on your own TV right now. Anyone who shows you a code could be trying to get into your account.
        </p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-3">
          <Button disabled={busy} onClick={() => void send(true)} className="h-11 flex-1 rounded-xl">
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Yes, sign in this TV"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setStep({ name: "enter" })} className="h-11 rounded-xl">
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send(false);
      }}
      className="flex flex-col gap-4"
    >
      <label htmlFor="tv-code" className="text-sm text-muted-foreground">
        The code shown on your TV
      </label>
      <input
        id="tv-code"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 12))}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        placeholder="ABCD-EFGH"
        className="h-14 rounded-xl bg-white/[0.06] px-4 text-center text-2xl font-semibold tracking-[0.3em] ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-primary"
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || code.replace(/[\s-]/g, "").length < 8} className="h-11 rounded-xl">
        {busy ? <Loader2 className="size-4 animate-spin" /> : "Continue"}
      </Button>
    </form>
  );
}
