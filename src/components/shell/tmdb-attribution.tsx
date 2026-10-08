/**
 * TMDB's required attribution: its logo and a plain statement that Roam is not endorsed or certified by TMDB
 * (https://www.themoviedb.org/api-terms-of-use). Kept smaller than Roam's own branding, as the terms ask.
 */
export function TmdbAttribution({ className = "", creditsHref }: { className?: string; creditsHref?: string }) {
  return (
    <div className={`flex flex-col items-center gap-2 text-center text-[11px] leading-snug text-muted-foreground/70 ${className}`}>
      {/* A small static SVG from TMDB's brand kit: nothing to optimise, and it must be shown as supplied. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/tmdb-logo.svg" alt="The Movie Database (TMDB)" width={110} height={14} className="h-3.5 w-auto" />
      <p className="max-w-xs">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      {creditsHref && (
        <a href={creditsHref} className="underline underline-offset-2 hover:text-foreground">
          Footage credits
        </a>
      )}
    </div>
  );
}
