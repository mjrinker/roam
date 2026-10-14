"use client";

import { useState } from "react";
import { toast } from "sonner";

const OPTIONS = [
  { value: "disabled", label: "Does the Dog Die: off" },
  { value: "limited", label: "Limited: asks when someone plays" },
  { value: "full", label: "Full: also asks when a page opens" },
] as const;

/** Which servers may use Does the Dog Die through the deployment's key, and how much (only the platform admin can change it). */
export function DddAccessSelect({ serverId, initial }: { serverId: string; initial: "disabled" | "limited" | "full" }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function change(next: string) {
    const before = value;
    setValue(next as typeof value);
    setBusy(true);
    const res = await fetch(`/api/platform/servers/${serverId}/ddd`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access: next }) }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) {
      setValue(before);
      toast.error("Couldn't save that.");
    }
  }
  return (
    <select
      aria-label="Does the Dog Die access for this server"
      value={value}
      disabled={busy}
      onChange={(e) => void change(e.target.value)}
      className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-xs sm:w-60"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value} className="bg-popover">
          {o.label}
        </option>
      ))}
    </select>
  );
}
