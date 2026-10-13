"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Runs the TMDB refresh now (what the daily job does), and says what it did. */
export function RefreshNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    const res = await fetch("/api/platform/tmdb-refresh", { method: "POST" });
    setBusy(false);
    if (!res.ok) return toast.error("Couldn't run the refresh.");
    const s = (await res.json()) as { refreshed: number; missing: number; failed: number; cleared: number };
    toast.success(`Refreshed ${s.refreshed}, TMDB no longer has ${s.missing}, ${s.failed} failed, ${s.cleared} cleared.`);
    router.refresh();
  }
  return (
    <Button variant="secondary" size="sm" onClick={() => void run()} disabled={busy}>
      {busy ? "Refreshing…" : "Run now"}
    </Button>
  );
}
