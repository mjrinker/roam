import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { db } from "@/lib/db/client";
import { requireServerAdmin } from "@/lib/auth/guards";
import { serverHouseholds } from "@/lib/ownership/owners";
import { formatHours, households, overview, parseRange, RANGES } from "@/lib/stats/queries";
import { DayBars } from "@/components/stats/bar-chart";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { cn } from "@/lib/utils";

const KIND_WORD: Record<string, string> = { movie: "Movie", show: "Show", audiobook: "Audiobook" };

/** Watch statistics for the server's admin: totals, the most watched, and each household's time (never an individual profile's). */
export default async function StatsPage({ params, searchParams }: PageProps<"/s/[serverId]/admin/stats">) {
  const { serverId } = await params;
  await requireServerAdmin(serverId);
  const days = parseRange((await searchParams).days);
  const [o, members] = await Promise.all([overview(db, { serverId, days }), serverHouseholds(db, serverId)]);
  const rows = await households(db, { serverId, days, members });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Admin", href: `/s/${serverId}/admin` }, { label: "Statistics" }]} />
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <BarChart3 className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Watch statistics</h1>
          <p className="text-sm text-muted-foreground">By household, never by individual profile. Time is counted from progress saved while playing, so it is an estimate.</p>
        </div>
        <nav aria-label="Time range" className="ml-auto flex gap-1.5">
          {RANGES.map((r) => (
            <Link key={r} href={`/s/${serverId}/admin/stats?days=${r}`} aria-current={r === days ? "page" : undefined} className={cn("rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors", r === days ? "bg-primary text-primary-foreground ring-primary" : "bg-white/[0.06] text-muted-foreground ring-white/10 hover:bg-white/10")}>
              {r === 365 ? "Year" : `${r} days`}
            </Link>
          ))}
        </nav>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Total time", formatHours(o.totalSeconds)],
          ["Watching", formatHours(o.watchSeconds)],
          ["Listening", formatHours(o.listenSeconds)],
          ["Active households", `${o.activeHouseholds} of ${members.length}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/[0.08]">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </section>

      <DayBars days={o.byDay} />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Most watched</h2>
        {o.top.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded in this time yet.</p>
        ) : (
          <ol className="divide-y divide-white/[0.06] rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08]">
            {o.top.map((t, i) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="w-6 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{KIND_WORD[t.kind] ?? t.kind} · {t.households === 1 ? "1 household" : `${t.households} households`}</span>
                <span className="w-16 shrink-0 text-right tabular-nums">{formatHours(t.seconds)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Households</h2>
        <ul className="divide-y divide-white/[0.06] rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08]">
          {rows.map((h) => (
            <li key={h.accountId}>
              <Link href={`/s/${serverId}/admin/stats/${h.accountId}?days=${days}`} className="flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-white/[0.05]">
                <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{h.titles === 1 ? "1 title" : `${h.titles} titles`}{h.lastDay ? ` · last ${h.lastDay}` : ""}</span>
                <span className="w-16 shrink-0 text-right tabular-nums">{formatHours(h.seconds)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
