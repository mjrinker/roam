"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ConnectionSummary } from "@/lib/storage/connections";
import { PROVIDERS, providerInfo, providerName } from "@/lib/storage/provider-info";
import type { StorageProviderKind } from "@/lib/db/schema";

const STATUS = {
  connected: { dot: "bg-emerald-400 shadow-[0_0_10px_oklch(0.75_0.17_160/0.7)]", text: "Connected" },
  needs_reauth: { dot: "bg-destructive", text: "Needs signing in again" },
  disconnected: { dot: "bg-muted-foreground/50", text: "Not connected" },
} as const;

/** The places this server's files are kept: any number of connections, of any mix of providers. */
export function StorageConnections({ serverId, connections, available }: { serverId: string; connections: ConnectionSummary[]; /** The kinds this deployment is set up to connect. */ available: StorageProviderKind[] }) {
  const offered = PROVIDERS.filter((p) => available.includes(p.kind));
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(connections.length === 0);
  const [provider, setProvider] = useState<StorageProviderKind>(offered[0]?.kind ?? "box");
  const [label, setLabel] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);

  const refresh = () => startTransition(() => router.refresh());

  async function rename() {
    if (!renaming) return;
    const res = await fetch(`/api/storage/connections/${renaming.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: renaming.label }) });
    if (!res.ok) return toast.error("Couldn't rename it.");
    setRenaming(null);
    refresh();
  }
  async function remove(c: ConnectionSummary) {
    if (!window.confirm(`Remove "${c.label}"? Roam forgets the sign-in; nothing in ${providerName(c.provider)} is touched.`)) return;
    const res = await fetch(`/api/storage/connections/${c.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toast.error(typeof body.error === "string" ? body.error : "Couldn't remove it.");
    }
    refresh();
  }
  function connect() {
    const info = providerInfo(provider);
    if (!info) return;
    window.location.href = info.connectHref(serverId, "new", label.trim() || info.name);
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Storage</h2>
        <Button variant="outline" size="sm" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add storage"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Where your media is kept. A library can use folders from any of these, and you can connect as many as you like, even several accounts of the same kind.</p>

      {adding && offered.length === 0 && <p className="text-sm text-muted-foreground">No storage is set up on this deployment yet: its sign-in keys are missing.</p>}
      {adding && offered.length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 py-4">
            <label className="grid gap-1.5 text-sm">
              Kind
              <select value={provider} onChange={(e) => setProvider(e.target.value as StorageProviderKind)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                {offered.map((p) => (
                  <option key={p.kind} value={p.kind} className="bg-popover">
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-48 flex-1 gap-1.5 text-sm">
              Name
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${providerName(provider)} (family)`} maxLength={60} />
            </label>
            <Button onClick={connect} disabled={offered.length === 0}>Connect {providerName(provider)}</Button>
          </CardContent>
        </Card>
      )}

      {connections.length === 0 && !adding && <p className="text-sm text-muted-foreground">Nothing connected yet.</p>}
      <div className="flex flex-col gap-2">
        {connections.map((c) => {
          const status = STATUS[c.authStatus];
          const info = providerInfo(c.provider);
          return (
            <Card key={c.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className={`size-2.5 shrink-0 self-start mt-1.5 rounded-full ${status.dot}`} />
                  <div className="min-w-0">
                    {renaming?.id === c.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void rename();
                        }}
                      >
                        <Input autoFocus value={renaming.label} onChange={(e) => setRenaming({ id: c.id, label: e.target.value })} maxLength={60} className="h-8 w-56" />
                        <Button type="submit" size="sm">Save</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                      </form>
                    ) : (
                      <p className="text-sm font-medium break-words">
                        {c.label} <span className="font-normal text-muted-foreground">· {providerName(c.provider)}</span>
                      </p>
                    )}
                    <p className="text-xs break-words text-muted-foreground">
                      {[status.text, c.accountName, c.libraries > 0 ? `${c.libraries} ${c.libraries === 1 ? "library" : "libraries"}` : null].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {info && c.authStatus !== "connected" && (
                    <Button render={<a href={info.connectHref(serverId, c.id, c.label)} />} size="sm" variant="secondary">
                      {c.authStatus === "disconnected" ? "Connect" : "Sign in again"}
                    </Button>
                  )}
                  {info && c.authStatus === "connected" && (
                    <Button render={<a href={info.connectHref(serverId, c.id, c.label)} />} size="sm" variant="ghost">
                      Reconnect
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: c.id, label: c.label })}>Rename</Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void remove(c)}>Remove</Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
