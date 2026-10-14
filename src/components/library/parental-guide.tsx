import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { CATEGORY_LABELS, SEVERITY_LABELS, severityAtLeast, type ContentFilterPrefs, type FilterSeverity } from "@/lib/content-filter/categories";
import type { GuideLine } from "@/lib/content-filter/playback";
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
export function ParentalGuide({ lines, prefs, imdbId }: { lines: GuideLine[]; prefs: ContentFilterPrefs; imdbId: string | null }) {
  if (lines.length === 0 && !imdbId) return null;
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
                    {l.scenes} scene{l.scenes === 1 ? "" : "s"} · {length(l.seconds)}
                    {skipped && <span className="text-primary"> · skipped for you</span>}
                  </p>
                </div>
                <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium", SEVERITY_STYLE[l.severity])}>{SEVERITY_LABELS[l.severity]}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {lines.length > 0 && (
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
