"use client";

import { CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";

/** "Select" for a photo grid: turns on picking several pictures. */
export function SelectToggle({ selecting, onChange }: { selecting: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={selecting}
      onClick={() => onChange(!selecting)}
      className={cn("flex h-9 w-fit items-center gap-2 rounded-xl px-3 text-sm ring-1 transition", selecting ? "bg-primary/20 text-primary ring-primary/40" : "bg-white/[0.06] text-muted-foreground ring-white/[0.08] hover:text-foreground")}
    >
      <CheckSquare className="size-4" />
      {selecting ? "Done selecting" : "Select"}
    </button>
  );
}
