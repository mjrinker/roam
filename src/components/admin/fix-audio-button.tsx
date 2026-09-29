"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Admin-only: this title's audio can't be decoded by Chrome/Firefox (Dolby /
 * DTS), so it plays silently there. Makes an AAC copy in Box next to the
 * original (which is never touched) that those browsers are switched to.
 */
export function FixAudioButton({ titleId, titleName }: { titleId: string; titleName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function fix() {
    setBusy(true);
    const res = await fetch(`/api/titles/${titleId}/fix-audio`, { method: "POST" });
    setBusy(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(typeof body.error === "string" ? body.error : "Couldn't start the audio fix.");
    } else if (body.status === "queued") {
      toast.success(`Making a browser-friendly copy of "${titleName}". This can take several minutes — resync when it appears in Box.`);
    } else if (body.status === "in-progress") {
      toast.info("Already working on it. Resync in a few minutes to pick up the result.");
    } else if (body.status === "already-done") {
      toast.info("This title already has a browser-friendly copy.");
    } else {
      toast.info("No audio problem found for this title.");
    }
    startTransition(() => router.refresh());
  }

  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={fix}
      title="Chrome and Firefox can't play this title's audio — make a browser-friendly copy"
      className="h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20"
    >
      <Volume2 />
      {busy ? "Starting…" : "Fix audio"}
    </Button>
  );
}
