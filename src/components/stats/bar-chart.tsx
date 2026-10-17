import { formatHours } from "@/lib/stats/queries";

/** Hours per day as bars (plain CSS; each bar says its day and time when hovered or read aloud). */
export function DayBars({ days }: { days: { day: string; seconds: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.seconds));
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <figure className="flex flex-col gap-2" aria-label="Time watched each day">
      <div className="flex h-32 items-end gap-px rounded-xl bg-white/[0.03] px-2 pt-2 ring-1 ring-white/[0.08]" role="img" aria-label={`${formatHours(days.reduce((n, d) => n + d.seconds, 0))} over ${days.length} days`}>
        {days.map((d) => (
          <div key={d.day} title={`${label(d.day)}: ${formatHours(d.seconds)}`} className="flex h-full min-w-0 flex-1 items-end">
            <div className="w-full rounded-t-sm bg-primary/80" style={{ height: `${Math.max(d.seconds > 0 ? 3 : 0, (d.seconds / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <figcaption className="flex justify-between text-xs text-muted-foreground">
        <span>{days.length ? label(days[0].day) : ""}</span>
        <span>Busiest day: {formatHours(max === 1 ? 0 : max)}</span>
        <span>{days.length ? label(days[days.length - 1].day) : ""}</span>
      </figcaption>
    </figure>
  );
}
