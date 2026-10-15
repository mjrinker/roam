"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export interface DeviceRow {
  id: string;
  label: string;
  lastUsedAt: string;
}

const ago = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 5) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/** The apps and devices signed in to this account with a code (a TV app, a phone app, Kodi), each with a way to sign it out. */
export function DevicesList({ devices }: { devices: DeviceRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  if (devices.length === 0) return null;
  async function signOut(d: DeviceRow) {
    if (!window.confirm(`Sign out “${d.label}”? It will need a new code to sign in again.`)) return;
    setBusy(d.id);
    const res = await fetch(`/api/v1/devices/${d.id}`, { method: "DELETE" }).catch(() => null);
    setBusy(null);
    if (res?.ok) {
      toast.success(`${d.label} signed out.`);
      router.refresh();
    } else toast.error("Couldn't sign that out.");
  }
  return (
    <section aria-label="Signed-in devices" className="flex w-full max-w-xl flex-col gap-3">
      <h2 className="text-lg font-semibold">Signed-in devices</h2>
      <ul className="flex flex-col gap-2">
        {devices.map((d) => (
          <li key={d.id} className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/10">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{d.label}</p>
              <p className="text-xs text-muted-foreground">Last used {ago(d.lastUsedAt)}</p>
            </div>
            <Button type="button" variant="secondary" size="sm" disabled={busy === d.id} onClick={() => signOut(d)}>
              Sign out
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
