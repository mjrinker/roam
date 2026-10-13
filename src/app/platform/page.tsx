import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { db } from "@/lib/db/client";
import { requireViewer } from "@/lib/auth/guards";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { loadPlatformStats } from "@/lib/platform/stats";
import { Panel, Problems, ProviderLimits, Tile, fmt, when } from "@/components/platform/platform-panels";
import { RefreshNowButton } from "@/components/platform/refresh-now-button";
import { Card, CardContent } from "@/components/ui/card";
import { providerName } from "@/lib/storage/provider-info";

/** The title is only set for a platform admin: anyone else gets the "not found" page, and a tab saying "Platform admin" would tell them the page is real. */
export async function generateMetadata(): Promise<Metadata> {
  const { account } = await requireViewer();
  return { robots: { index: false, follow: false }, ...(account.isPlatformAdmin ? { title: "Platform admin" } : {}) };
}
export const dynamic = "force-dynamic";

/** Everything about the whole platform in one place: for the account that runs it (see scripts/grant-platform-admin.ts), not for server admins. */
export default async function PlatformPage() {
  await requirePlatformAdmin();
  const stats = await loadPlatformStats(db);
  const { totals, activity, health } = stats;
  const lastRun = health.tmdb.lastRun;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-8 sm:px-8">
      <header className="flex flex-col gap-2">
        <Link href="/servers" className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Servers
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Platform admin</h1>
        <p className="text-sm text-muted-foreground">Every server at a glance, the limits outside services put on Roam, and what needs attention.</p>
      </header>

      <Panel title="Outside accounts and their limits" note="Accounts linked to Roam's apps, counted once however many servers use them. Dropbox's app console is the final word on its count.">
        <ProviderLimits providers={stats.providers} />
      </Panel>

      <Panel title="At a glance">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Accounts" value={fmt(totals.accounts)} hint={`${fmt(totals.guests)} demo guests`} />
          <Tile label="Servers" value={fmt(totals.servers)} />
          <Tile label="Libraries" value={fmt(totals.libraries)} hint={Object.entries(stats.librariesByKind).map(([k, n]) => `${n} ${k}`).join(" · ") || undefined} />
          <Tile label="Items" value={fmt(totals.titles)} hint={`${fmt(totals.episodes)} episodes · ${fmt(totals.files)} files`} />
          <Tile label="New accounts" value={fmt(activity.newAccounts7)} hint={`this week · ${fmt(activity.newAccounts30)} this month`} />
          <Tile label="Active people" value={fmt(activity.active7)} hint={`this week · ${fmt(activity.active30)} this month`} />
          <Tile label="Pending invites" value={fmt(totals.pendingInvites)} />
          <Tile label="Storage connections" value={fmt(stats.connections.reduce((a, c) => a + c.total, 0))} hint={stats.connections.map((c) => `${c.total} ${providerName(c.provider)}`).join(" · ") || undefined} />
        </div>
      </Panel>

      <Panel title="Needs attention">
        <Problems health={health} />
      </Panel>

      <Panel title="Scanning and TMDB" note="Files Roam couldn't read yet, and the shared TMDB cache that has to be refreshed within six months.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Files waiting to be read" value={fmt(health.probes.pending)} />
          <Tile label="Files that failed" value={fmt(health.probes.failed)} />
          <Tile label="TMDB entries" value={fmt(health.tmdb.entries)} hint={health.tmdb.oldestDays !== null ? `oldest ${health.tmdb.oldestDays} days` : undefined} />
          <Tile label="Due for refresh" value={fmt(health.tmdb.due)} hint="5 months or older" />
        </div>
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium">Daily TMDB refresh</p>
              <p className="text-xs text-muted-foreground">
                {lastRun
                  ? `Last ran ${when(lastRun.at)}${lastRun.summary ? ` · refreshed ${String(lastRun.summary.refreshed ?? 0)}, ${String(lastRun.summary.failed ?? 0)} failed, ${String(lastRun.summary.cleared ?? 0)} cleared` : ""}`
                  : "Hasn't run yet. It runs daily once the deployment has CRON_SECRET set."}
              </p>
            </div>
            <RefreshNowButton />
          </CardContent>
        </Card>
      </Panel>

      <Panel title="Servers" note="Newest first.">
        <div className="flex flex-col gap-2">
          {stats.servers.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                <div className="min-w-[min(100%,14rem)] flex-1">
                  <p className="font-medium break-words">{s.name}</p>
                  <p className="text-xs break-all text-muted-foreground">{s.owner} · created {s.createdAt.toLocaleDateString("en-US", { dateStyle: "medium" })}</p>
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {fmt(s.members)} member{s.members === 1 ? "" : "s"} · {fmt(s.libraries)} librar{s.libraries === 1 ? "y" : "ies"} · {fmt(s.titles)} items · {fmt(s.connections)} storage
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </Panel>
    </main>
  );
}
