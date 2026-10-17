"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NameDialog } from "@/components/playlists/name-dialog";

/** Rename and delete for one of the profile's labels (deleting leaves the titles as they are). */
export function LabelActions({ serverId, id, name }: { serverId: string; id: string; name: string }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  async function rename(next: string): Promise<string | null> {
    const res = await fetch(`/api/labels/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: next }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return body.error ?? "Couldn't rename it.";
    toast.success("Renamed.");
    router.refresh();
    return null;
  }

  async function remove() {
    setBusy(true);
    const res = await fetch(`/api/labels/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return toast.error("Couldn't delete it.");
    toast.success(`Deleted "${name}".`);
    router.push(`/s/${serverId}/labels`);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="secondary" className="gap-2" onClick={() => setRenaming(true)}>
          <Pencil className="size-4" /> Rename
        </Button>
        <Button variant="secondary" className="gap-2" onClick={() => setDeleting(true)}>
          <Trash2 className="size-4" /> Delete
        </Button>
      </div>
      {renaming && <NameDialog open onOpenChange={setRenaming} title="Rename label" submitLabel="Rename" initialName={name} placeholder="Label name" onSubmit={rename} />}
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{name}”?</DialogTitle>
            <DialogDescription>The label goes away from everything it is on. The movies, shows and books themselves are not touched.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
