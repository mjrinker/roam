"use client";

import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * An open link anyone can use to join this server as a viewer, as often as they like, until it is switched off
 * or replaced. For a public demo: guests can enter with one click, and everyone who joins this way is hidden
 * from the other members.
 */
export function JoinLinkManager({ serverId, initialToken, initialDemo, visibleProfileNames }: { serverId: string; initialToken: string | null; initialDemo: boolean; visibleProfileNames: string[] }) {
  const [token, setToken] = useState(initialToken);
  const [demo, setDemo] = useState(initialDemo);
  const [busy, setBusy] = useState(false);

  async function change(body: { enabled?: boolean; rotate?: boolean; demo?: boolean }, done: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/servers/${serverId}/join-link`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error();
      const next = (await res.json()) as { joinToken: string | null; isDemo: boolean };
      setToken(next.joinToken);
      setDemo(next.isDemo);
      toast.success(done);
    } catch {
      toast.error("Couldn't save that change.");
    } finally {
      setBusy(false);
    }
  }

  // The page's own address: empty while rendering on the server, filled in the browser.
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => ""
  );
  const url = token && origin ? `${origin}/join/${token}` : null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Open join link</h2>
      <Card>
        <CardContent className="flex flex-col gap-4 py-4">
          <p className="text-sm text-muted-foreground">
            Anyone with this link can join <strong>{demo ? "this demo" : "this server"}</strong> as a viewer, as many times as they like, until you switch it off. They can watch what you
            share and nothing else. Switch it off or replace it at any time.
          </p>
          {token ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-white/[0.05] px-3 py-2 text-xs">{url ?? "…"}</code>
              <Button type="button" variant="secondary" disabled={!url} onClick={() => url && navigator.clipboard.writeText(url).then(() => toast.success("Link copied."), () => toast.error("Couldn't copy."))}>
                Copy
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Replace the link? The current one stops working straight away.")) void change({ rotate: true }, "New link created. The old one no longer works.");
                }}
              >
                Replace
              </Button>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void change({ enabled: false }, "Link switched off.")}>
                Switch off
              </Button>
            </div>
          ) : (
            <div>
              <Button type="button" disabled={busy} onClick={() => void change({ enabled: true }, "Link created.")}>
                Create an open join link
              </Button>
            </div>
          )}
          {(token || demo) && visibleProfileNames.length > 0 && (
            <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-100/90 ring-1 ring-amber-400/20">
              Visitors can see your profile{visibleProfileNames.length > 1 ? "s" : ""} named <strong>{visibleProfileNames.join(", ")}</strong> (for example when sharing a playlist). A profile is named from your email address
              by default, so rename it or hide it from the server in Profiles before sharing the link publicly.
            </p>
          )}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={demo}
              disabled={busy}
              onChange={(e) => {
                const on = e.target.checked;
                const ok = !on || window.confirm("Make this a public demo? New visitors can enter as guests, are hidden from each other, and a daily limit applies to playback. Only do this for a server that holds nothing private.");
                if (ok) void change({ demo: on }, on ? "Marked as a public demo." : "No longer a public demo.");
              }}
            />
            <span>
              <span className="font-medium">This is a public demo</span>
              <span className="block text-xs text-muted-foreground">Offers one-click guest entry, shows a notice that the footage is placeholder, hides new visitors from each other and caps plays per day.</span>
            </span>
          </label>
        </CardContent>
      </Card>
    </section>
  );
}
