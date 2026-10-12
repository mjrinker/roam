"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** The server's danger zone: remove it from Roam after typing its name (files in storage are never touched). */
export function DeleteServerButton({ serverId, serverName }: { serverId: string; serverName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch(`/api/servers/${serverId}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: typed }) });
    if (!res.ok) {
      setBusy(false);
      const body = await res.json().catch(() => ({}));
      return toast.error(typeof body.error === "string" ? body.error : "Couldn't delete the server.");
    }
    toast.success(`"${serverName}" was deleted.`);
    router.push("/servers");
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-destructive">Danger zone</h2>
      <Card className="ring-destructive/30">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Delete this server</p>
            <p className="text-xs text-muted-foreground">Removes it from Roam for everyone. Your files in storage are not touched.</p>
          </div>
          <Button variant="destructive" onClick={() => setOpen(true)}>
            Delete server
          </Button>
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={(o) => !busy && (setOpen(o), !o && setTyped(""))}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={remove} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Delete &quot;{serverName}&quot;?</DialogTitle>
              <DialogDescription>
                This removes the server from Roam: all of its libraries and what is listed in them, everyone&apos;s watch history and playlists on it, its invitations and join link, and its storage sign-ins. Members keep their accounts. Nothing in your storage (Box, Dropbox, OneDrive...) is deleted. This can&apos;t be undone.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              Type the server&apos;s name to confirm
              <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={serverName} autoComplete="off" />
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={busy || typed !== serverName}>
                {busy ? "Deleting…" : "Delete server"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
