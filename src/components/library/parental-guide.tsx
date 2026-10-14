import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { CATEGORY_LABELS, SEVERITY_LABELS, severityAtLeast, type ContentFilterPrefs, type FilterSeverity } from "@/lib/content-filter/categories";
import type { GuideLine } from "@/lib/content-filter/playback";
import type { DddReport } from "@/lib/ddd/transform";
import { DddCredit } from "@/components/library/ddd-credit";
import { cn } from "@/lib/utils";

const SEVERITY_STYLE: Record<FilterSeverity, string> = {
  low: "bg-emerald-400/15 text-emerald-300",
  medium: "bg-amber-400/15 text-amber-300",
  high: "bg-red-400/15 text-red-300",
};

const length = (seconds: number) => (seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds} sec`);

/**
 * What a movie contains, by category, from its content filter file: the strongest level, and how many scenes and how long. Marks the
 * ones this profile skips. Not shown when there is nothing to say; the IMDb link is there whenever the movie has an IMDb page.
 */
export function ParentalGuide({ lines, prefs, imdbId, reports = [] }: { lines: GuideLine[]; prefs: ContentFilterPrefs; imdbId: string | null; reports?: DddReport[] }) {
  if (lines.length === 0 && reports.length === 0 && !imdbId) return null;
  const fromCommunity = reports.length > 0 || lines.some((l) => l.source === "community");
  const fromFile = lines.some((l) => !l.source);
  return (
    <section aria-label="Parental guide" className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pt-8 sm:px-8">
      <h2 className="text-lg font-semibold tracking-tight">Parental guide</h2>
      {lines.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {lines.map((l) => {
            const threshold = prefs[l.category];
            const skipped = threshold !== undefined && severityAtLeast(l.severity, threshold);
            return (
              <li key={l.category} className="flex min-w-0 items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2.5 ring-1 ring-white/[0.08]">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{CATEGORY_LABELS[l.category]}</p>
                  <p className="text-xs text-muted-foreground">
                    {l.source === "community" ? "Reported by the community · " : ""}
                    {l.scenes} scene{l.scenes === 1 ? "" : "s"} · {length(l.seconds)}
                    {skipped && <span className="text-primary"> · skipped for you</span>}
                  </p>
                </div>
                {l.source !== "community" && <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium", SEVERITY_STYLE[l.severity])}>{SEVERITY_LABELS[l.severity]}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {reports.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">What the community reports</h3>
          <ul className="flex flex-wrap gap-1.5">
            {reports.map((r) => (
              <li key={r.topicName} className="rounded-full bg-white/[0.06] px-3 py-1 text-xs ring-1 ring-white/[0.08]">
                {r.topicName} <span className="text-muted-foreground">· {r.yes} yes, {r.no} no</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fromCommunity && <DddCredit className="text-xs text-muted-foreground" />}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {fromFile && (
          <span>
            From a content filter file. <Link href="/profiles?manage=1" className="underline underline-offset-2 hover:text-foreground">Choose what to skip in your profile.</Link>
          </span>
        )}
        {imdbId && (
          <a href={`https://www.imdb.com/title/${imdbId}/parentalguide`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
            Parents guide on IMDb <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        )}
      </p>
    </section>
  );
}
