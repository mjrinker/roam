import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { serverMembers } from "@/lib/db/schema";
import { requireServerAdmin } from "@/lib/auth/guards";
import { isUuid } from "@/lib/playlists/http";
import { formatHours, householdDetail, parseRange } from "@/lib/stats/queries";
import { DayBars } from "@/components/stats/bar-chart";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";

const KIND_WORD: Record<string, string> = { movie: "Movie", show: "Show", audiobook: "Audiobook" };

/** What one household watched: its time by day and its most watched titles (all its profiles together). */
export default async function HouseholdStatsPage({ params, searchParams }: PageProps<"/s/[serverId]/admin/stats/[accountId]">) {
  const { serverId, accountId } = await params;
  if (!isUuid(accountId)) notFound();
  await requireServerAdmin(serverId);
  const days = parseRange((await searchParams).days);
  const [member] = await db.select({ id: serverMembers.id }).from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.profileId, accountId)));
  const detail = await householdDetail(db, { serverId, accountId, days, isMember: !!member });
  if (!detail) notFound();
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Admin", href: `/s/${serverId}/admin` }, { label: "Statistics", href: `/s/${serverId}/admin/stats?days=${days}` }, { label: detail.name }]} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{detail.name}</h1>
        <p className="text-sm text-muted-foreground">{formatHours(detail.totalSeconds)} in the last {days === 365 ? "year" : `${days} days`}, all of the household&apos;s profiles together.</p>
      </div>
      <DayBars days={detail.byDay} />
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">What they watched</h2>
        {detail.top.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded in this time.</p>
        ) : (
          <ol className="divide-y divide-white/[0.06] rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08]">
            {detail.top.map((t, i) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="w-6 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{KIND_WORD[t.kind] ?? t.kind} · last {t.lastDay}</span>
                <span className="w-16 shrink-0 text-right tabular-nums">{formatHours(t.seconds)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
