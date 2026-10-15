"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * "Set owner" in the selection bar, for the server's admin: make a household the owner of everything selected (a show means all its
 * seasons), or take that away. Each title can also be done one at a time on its own page.
 */
export function BulkOwnerButton({ serverId, resolve, count, disabled, households }: { serverId: string; resolve: () => Promise<string[]>; count: number; disabled?: boolean; households: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [household, setHousehold] = useState("");
  const [busy, setBusy] = useState(false);

  async function apply(action: "assign" | "remove") {
    setBusy(true);
    try {
      const ids = await resolve();
      let changed = 0;
      // The server takes at most 3,000 at a time.
      for (let i = 0; i < ids.length; i += 3000) {
        const res = await fetch("/api/ownership/owners", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverId, accountId: household, action, titleIds: ids.slice(i, i + 3000) }) });
        if (!res.ok) throw new Error(changed > 0 ? `Stopped partway: ${changed} done.` : "Couldn't do that.");
        const r = (await res.json()) as { added?: number; removed?: number };
        changed += r.added ?? r.removed ?? 0;
      }
      toast.success(action === "assign" ? `Made owner of ${changed.toLocaleString()} ${changed === 1 ? "title or season" : "titles and seasons"}.` : `Removed from ${changed.toLocaleString()}.`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => setOpen(true)} className="h-10 gap-2 rounded-xl">
        <UserCheck className="size-4" /> Set owner
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && !busy && setOpen(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Set owner for {count.toLocaleString()} selected</DialogTitle>
              <DialogDescription>Choose the household. A show counts as all of its seasons.</DialogDescription>
            </DialogHeader>
            <select aria-label="Household" value={household} onChange={(e) => setHousehold(e.target.value)} className="h-10 min-w-0 max-w-full rounded-lg border border-input bg-transparent px-3 text-sm">
              <option value="">Choose a household…</option>
              {households.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy || !household} onClick={() => apply("assign")} className="rounded-xl">
                Make owner
              </Button>
              <Button type="button" variant="secondary" disabled={busy || !household} onClick={() => apply("remove")} className="rounded-xl">
                Remove as owner
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
