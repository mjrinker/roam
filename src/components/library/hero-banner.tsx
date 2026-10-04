import { Artwork as Image } from "@/components/ui/artwork";
import Link from "next/link";
import { Info, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface HeroBannerData {
  backdropUrl: string | null;
  eyebrow: string;
  title: string;
  subtitle?: string | null;
  overview?: string | null;
  primaryHref: string;
  primaryLabel: string;
  detailsHref?: string;
  progressFraction?: number | null;
}

/** The big cinematic banner at the top of Home. */
export function HeroBanner({ hero }: { hero: HeroBannerData }) {
  return (
    <section className="relative isolate -mt-16 flex min-h-[440px] items-end overflow-hidden sm:min-h-[500px] lg:min-h-[560px]">
      {hero.backdropUrl ? (
        <Image
          src={hero.backdropUrl}
          alt=""
          fill
          priority
          sizes="100vw"
          className="-z-20 object-cover object-[50%_20%]"
        />
      ) : (
        <div className="absolute inset-0 -z-20 bg-gradient-to-br from-secondary via-muted to-background" />
      )}
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-background/55 to-background/10" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-background/85 via-background/30 to-transparent" />

      <div className="flex max-w-2xl flex-col gap-3 px-4 pt-24 pb-10 sm:px-8 lg:pb-14">
        <span className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">
          {hero.eyebrow}
        </span>
        <h1 className="text-3xl leading-[1.05] font-semibold tracking-tight text-balance drop-shadow-lg sm:text-5xl">
          {hero.title}
        </h1>
        {hero.subtitle && (
          <p className="text-sm font-medium text-foreground/80 sm:text-base">{hero.subtitle}</p>
        )}
        {hero.overview && (
          <p className="line-clamp-3 max-w-xl text-sm leading-relaxed text-foreground/70 sm:text-[15px]">
            {hero.overview}
          </p>
        )}
        {typeof hero.progressFraction === "number" && hero.progressFraction > 0 && (
          <div className="h-1 w-48 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, hero.progressFraction * 100)}%` }}
            />
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            render={<Link href={hero.primaryHref} />}
            className="h-11 gap-2 rounded-xl px-6 text-[15px] font-semibold shadow-[0_8px_30px_-8px_oklch(0.853_0.163_169/0.7)]"
          >
            <Play className="size-4" fill="currentColor" />
            {hero.primaryLabel}
          </Button>
          {hero.detailsHref && (
            <Button
              render={<Link href={hero.detailsHref} />}
              variant="secondary"
              className="h-11 gap-2 rounded-xl bg-white/10 px-5 text-[15px] backdrop-blur hover:bg-white/20"
            >
              <Info className="size-4" />
              Details
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
