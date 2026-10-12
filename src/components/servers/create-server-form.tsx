"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateServerForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const res = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(typeof body.error === "string" ? body.error : "Couldn't create that server.");
      setSubmitting(false);
      return;
    }
    const { server } = await res.json();
    // Server settings opens with "Add storage" showing, since there is none yet: the admin picks Box, Dropbox, OneDrive ... there.
    router.push(`/s/${server.id}/admin`);
  }

  return (
    <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6 sm:p-7">
      <div className="mb-5 flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Plus className="size-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Start a new server</h2>
          <p className="text-sm text-muted-foreground">
            You&apos;ll choose where your media is kept next (Box, Dropbox, OneDrive and more), then which folders to share.
          </p>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="server-name">Server name</Label>
          <Input
            id="server-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="The Family Server"
            required
            className="h-11 rounded-xl bg-white/[0.05] px-3.5"
          />
        </div>
        <Button
          type="submit"
          disabled={submitting}
          className="h-11 rounded-xl px-5 text-[15px] font-semibold"
        >
          {submitting ? "Creating…" : "Create server"}
        </Button>
      </form>
    </div>
  );
}
