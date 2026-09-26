"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Admin-only: resyncs just this one title's Box folder instead of rescanning the whole library. */
export function TitleResyncButton({
  titleId,
  titleName,
}: {
  titleId: string;
  titleName: string;
}) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [, startTransition] = useTransition();

  async function resync() {
    setSyncing(true);
    const res = await fetch(`/api/titles/${titleId}/sync`, { method: "POST" });
    setSyncing(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(typeof body.error === "string" ? body.error : "Resync failed.");
      return;
    }
    const body = await res.json();
    if (body.errors?.length) {
      toast.warning(`Resynced "${titleName}" with ${body.errors.length} error(s): ${body.errors[0]}`);
    } else {
      toast.success(`Resynced "${titleName}".`);
    }
    startTransition(() => router.refresh());
  }

  return (
    <Button variant="outline" size="lg" disabled={syncing} onClick={resync}>
      <RefreshCw className={syncing ? "animate-spin" : ""} />
      {syncing ? "Syncing…" : "Resync"}
    </Button>
  );
}
