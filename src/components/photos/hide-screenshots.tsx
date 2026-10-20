"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Camera, CameraOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** "Screenshots: shown / hidden" for Photos: a profile's choice, remembered, applied to the timeline, albums and search. */
export function HideScreenshots({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(initial);
  const [pending, startTransition] = useTransition();

  async function toggle() {
    const next = !hidden;
    setHidden(next);
    const res = await fetch("/api/viewers/current/photos", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ hideScreenshots: next }) }).catch(() => null);
    if (!res?.ok) {
      setHidden(!next);
      return toast.error("Couldn't change that.");
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={pending}
      aria-pressed={hidden}
      className={cn("flex h-9 items-center gap-2 rounded-xl px-3 text-sm ring-1 transition disabled:opacity-60", hidden ? "bg-primary/20 text-primary ring-primary/40" : "bg-white/[0.06] text-muted-foreground ring-white/[0.08] hover:text-foreground")}
    >
      {hidden ? <CameraOff className="size-4" /> : <Camera className="size-4" />}
      {hidden ? "Screenshots hidden" : "Hide screenshots"}
    </button>
  );
}
