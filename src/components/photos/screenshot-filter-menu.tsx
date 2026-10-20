"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ListFilter } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SCREENSHOT_FILTERS, SCREENSHOT_FILTER_LABEL, type ScreenshotFilter } from "@/lib/photos/screenshot-filter";
import { cn } from "@/lib/utils";

/** A "Filter" menu for Photos: Screenshots: Show / Hide / Only. A profile's choice, remembered, applied to the timeline, albums, search and stepping. */
export function ScreenshotFilterMenu({ initial }: { initial: ScreenshotFilter }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();

  async function choose(next: ScreenshotFilter) {
    const before = value;
    setValue(next);
    const res = await fetch("/api/viewers/current/photos", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screenshots: next }) }).catch(() => null);
    if (!res?.ok) {
      setValue(before);
      return toast.error("Couldn't change that.");
    }
    startTransition(() => router.refresh());
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Filter photos"
        disabled={pending}
        className={cn("flex h-9 items-center gap-2 rounded-xl px-3 text-sm outline-none ring-1 transition focus-visible:ring-2 disabled:opacity-60", value !== "show" ? "bg-primary/20 text-primary ring-primary/40" : "bg-white/[0.06] text-muted-foreground ring-white/[0.08] hover:text-foreground")}
      >
        <ListFilter className="size-4" />
        {value === "show" ? "Filter" : `Screenshots: ${SCREENSHOT_FILTER_LABEL[value]}`}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuLabel>Screenshots</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => void choose(v as ScreenshotFilter)}>
          {SCREENSHOT_FILTERS.map((f) => (
            <DropdownMenuRadioItem key={f} value={f}>
              {SCREENSHOT_FILTER_LABEL[f]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
