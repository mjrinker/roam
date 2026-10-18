"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDataSaverState } from "@/components/ui/data-saver-context";
import { describeDataSaver, type DataSaverMode } from "@/lib/player/data-saver-mode";
import { cn } from "@/lib/utils";

const CHOICES: { mode: DataSaverMode; label: string; hint: string }[] = [
  { mode: "profile", label: "Same as my profile", hint: "Whatever this profile's Data saver setting says." },
  { mode: "auto", label: "Automatic", hint: "On while on mobile data, off on Wi-Fi. Where this browser can't tell the difference (Safari, Firefox), it uses the profile's setting." },
  { mode: "on", label: "Always on", hint: "On this device only." },
  { mode: "off", label: "Always off", hint: "On this device only." },
];

/** Data saver for THIS device: follow the profile, follow the connection, or stay on or off. Remembered on the device. */
export function DataSaverDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { mode, setMode, profileOn, metered } = useDataSaverState();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Data saver on this device</DialogTitle>
          <DialogDescription>Now: {describeDataSaver(mode, profileOn, metered)}. Lower video quality and lighter pictures to save mobile data.</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Data saver" className="grid gap-2">
          {CHOICES.map((c) => (
            <button
              key={c.mode}
              type="button"
              role="radio"
              aria-checked={mode === c.mode}
              onClick={() => setMode(c.mode)}
              className={cn("rounded-lg p-3 text-left ring-1 transition-colors", mode === c.mode ? "bg-primary/10 ring-primary" : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.06]")}
            >
              <span className="block text-sm font-medium">{c.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{c.hint}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
