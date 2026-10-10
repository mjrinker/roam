"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dices } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** "Help me choose" from one library's page: that library is the one chosen from. */
export function ChooseButton({ serverId, libraryId, className }: { serverId: string; libraryId: string; className?: string }) {
  return (
    <Button render={<Link href={`/s/${serverId}/choose?libs=${libraryId}`} />} variant="secondary" className={cn("h-10 gap-2 rounded-xl", className)}>
      <Dices className="size-4" /> Help me choose
    </Button>
  );
}

/** "Help me choose" from Home: first pick which libraries to choose from. */
export function ChooseHomeButton({ serverId, libraries }: { serverId: string; libraries: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(libraries.map((l) => l.id)));
  if (libraries.length === 0) return null;
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const start = () => router.push(`/s/${serverId}/choose?libs=${libraries.filter((l) => picked.has(l.id)).map((l) => l.id).join(",")}`);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)} className="h-11 gap-2 rounded-xl">
        <Dices className="size-4" /> Help me choose
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>What should we choose from?</DialogTitle>
            <DialogDescription>Pick one or more libraries. You&apos;ll be shown two things at a time to choose between.</DialogDescription>
          </DialogHeader>
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {libraries.map((l) => (
              <li key={l.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.06]">
                  <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} className="size-4 accent-[var(--primary)]" />
                  <span className="truncate text-sm">{l.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setPicked(picked.size === libraries.length ? new Set() : new Set(libraries.map((l) => l.id)))}>
              {picked.size === libraries.length ? "Clear all" : "Select all"}
            </button>
            <Button type="button" disabled={picked.size === 0} onClick={start} className="gap-2 rounded-xl">
              <Dices className="size-4" /> Start
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
