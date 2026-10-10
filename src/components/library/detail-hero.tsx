import { Artwork as Image } from "@/components/ui/artwork";
import { Film, Headphones, Tv } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ExternalRatings, type ExternalRatingsData } from "@/components/library/external-ratings";
import type { TitleKind } from "@/lib/db/schema";

/** Plex-style title header: full-bleed blurred backdrop, poster, metadata, and an actions slot. */
export function DetailHero({
  kind,
  title,
  backdropUrl,
  posterUrl,
  meta,
  externalRatings,
  genres,
  overview,
  breadcrumbs,
  below,
  children,
}: {
  kind: TitleKind;
  title: string;
  backdropUrl: string | null;
  posterUrl: string | null;
  meta: (string | null | undefined | false)[];
  externalRatings?: ExternalRatingsData;
  genres?: string[] | null;
  overview?: string | null;
  breadcrumbs?: React.ReactNode;
  /** Sections under the header (a movie's extras). */
  below?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const Icon = kind === "show" ? Tv : kind === "audiobook" ? Headphones : Film;
  const metaItems = meta.filter(Boolean) as string[];

  return (
    <>
    <section className="relative isolate -mt-16 overflow-hidden">
      {backdropUrl ? (
        <Image
          src={backdropUrl}
          alt=""
          fill
          priority
          sizes="100vw"
          className="-z-20 scale-105 object-cover object-[50%_15%] opacity-60 blur-[2px]"
        />
      ) : (
        <div className="absolute inset-0 -z-20 bg-gradient-to-br from-secondary via-muted to-background" />
      )}
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-background/70 to-background/20" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-background/90 via-background/40 to-transparent" />

      {breadcrumbs && <div className="absolute inset-x-0 top-[4.75rem] px-4 sm:px-8">{breadcrumbs}</div>}

      <div className="flex flex-col items-center gap-8 px-4 pt-28 pb-10 sm:px-8 md:flex-row md:items-end md:gap-10 md:pt-40 md:pb-14">
        <div className="relative aspect-[2/3] w-44 shrink-0 overflow-hidden rounded-2xl bg-muted shadow-[0_30px_60px_-20px_rgba(0,0,0,0.9)] ring-1 ring-white/15 sm:w-52 md:w-60">
          {posterUrl ? (
            <Image
              src={posterUrl}
              alt={title}
              fill
              priority
              sizes="(min-width: 768px) 240px, 208px"
              className="object-cover"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-secondary to-muted p-4 text-center">
              <Icon className="size-8 text-muted-foreground/60" />
              <span className="text-sm font-medium text-muted-foreground">{title}</span>
            </div>
          )}
        </div>

        <div className="flex max-w-3xl min-w-0 flex-col gap-4 text-center md:text-left">
          <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance drop-shadow-lg md:text-5xl lg:text-6xl">
            {title}
          </h1>

          {metaItems.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-sm text-foreground/75 md:justify-start">
              {metaItems.map((m, i) => (
                <span key={i} className="flex items-center gap-2.5">
                  {i > 0 && <span className="size-1 rounded-full bg-foreground/35" />}
                  {m}
                </span>
              ))}
            </div>
          )}

          {externalRatings && <ExternalRatings {...externalRatings} />}

          {genres && genres.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5 md:justify-start">
              {genres.map((g) => (
                <Badge
                  key={g}
                  variant="outline"
                  className="h-6 border-white/15 bg-white/[0.06] px-2.5 text-xs backdrop-blur"
                >
                  {g}
                </Badge>
              ))}
            </div>
          )}

          {overview && (
            <p className="max-w-2xl text-[15px] leading-relaxed text-foreground/75">{overview}</p>
          )}

          {children && (
            <div className="mt-1 flex flex-wrap items-start justify-center gap-3 md:justify-start">
              {children}
            </div>
          )}
        </div>
      </div>
    </section>
    {below}
    </>
  );
}
