"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CircleOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { doneWords, type DoneKind } from "@/lib/watch/words";

type MarkKind = "title" | "episode" | "season" | "show";

/**
 * "Mark as watched / listened to / read" (and the opposite, depending on where things stand now). `scope` names what is being marked
 * when it isn't the page's own subject ("season", "show"). Only this profile's own shelf changes.
 */
export function MarkDoneButton({
  kind,
  id,
  done,
  media,
  scope,
  variant = "hero",
  compact = false,
}: {
  kind: MarkKind;
  id: string;
  /** Whether everything it covers is already marked done. */
  done: boolean;
  media: DoneKind;
  scope?: string;
  /** `hero` is a labelled button for detail pages; `icon` is a compact round button for list rows. */
  variant?: "hero" | "icon";
  /** A smaller labelled button (for a season's heading). */
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const words = doneWords(media);
  const label = scope ? (done ? words.markUndone : words.markDone).replace(" as ", ` ${scope} as `) : done ? words.markUndone : words.markDone;

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch("/api/watch-state/mark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id, done: !done }) });
      if (!res.ok) throw new Error("failed");
      toast.success(done ? words.undoneToast : words.doneToast);
      router.refresh();
    } catch {
      toast.error("Couldn't change that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={label}
        aria-label={label}
        className="flex size-8 items-center justify-center rounded-full bg-black/50 text-foreground/80 ring-1 ring-white/10 backdrop-blur transition hover:bg-black/70 hover:text-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : done ? <CircleOff className="size-4" /> : <Check className="size-4" />}
      </button>
    );
  }
  return (
    <Button type="button" variant="secondary" onClick={toggle} disabled={busy} className={compact ? "h-9 gap-1.5 rounded-lg px-3.5 text-sm font-medium" : "h-12 gap-2 rounded-xl px-5 text-sm font-medium"}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : done ? <CircleOff className="size-4" /> : <Check className="size-4" />}
      {label}
    </Button>
  );
}
