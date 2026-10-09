"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, Loader2, Play, Tv } from "lucide-react";
import { cn } from "@/lib/utils";
import { AddToPlaylistMenu } from "@/components/playlists/add-to-playlist-menu";
import { MarkDoneButton } from "@/components/library/mark-done-button";

export interface EpisodeRowData {
  id: string;
  seasonId: string;
  number: number;
  name: string | null;
  overview: string | null;
  stillUrl: string | null;
  runtimeLabel: string | null;
  ready: boolean;
  /** 0..1 */
  progressFraction: number;
  watched: boolean;
}

export interface SeasonTab {
  id: string;
  number: number;
}

function EpisodeRow({ ep, serverId }: { ep: EpisodeRowData; serverId: string }) {
  const body = (
    <>
      <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-white/[0.08] sm:w-56">
        {ep.stillUrl ? (
          <Image
            src={ep.stillUrl}
            alt=""
            fill
            sizes="(min-width: 640px) 224px, 144px"
            className="object-cover transition-transform duration-500 group-hover/ep:scale-[1.04]"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-secondary to-muted">
            <Tv className="size-6 text-muted-foreground/50" />
          </div>
        )}
        {ep.ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover/ep:opacity-100">
            <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
              <Play className="ml-0.5 size-4" fill="currentColor" />
            </span>
          </div>
        )}
        {ep.watched && (
          <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3" strokeWidth={3} />
          </span>
        )}
        {ep.progressFraction > 0 && !ep.watched && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.min(100, ep.progressFraction * 100)}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-[15px] font-medium group-hover/ep:text-primary">
            <span className="mr-1.5 text-muted-foreground tabular-nums">{ep.number}.</span>
            {ep.name ?? `Episode ${ep.number}`}
          </p>
          {ep.runtimeLabel && (
            <span className="shrink-0 text-xs text-muted-foreground">{ep.runtimeLabel}</span>
          )}
        </div>
        {ep.overview && (
          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground sm:line-clamp-3">
            {ep.overview}
          </p>
        )}
        {!ep.ready && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
            <Loader2 className="size-3 animate-spin" /> Getting ready…
          </p>
        )}
      </div>
    </>
  );

  const classes =
    "group/ep flex gap-4 rounded-xl p-2.5 transition-colors sm:gap-5";
  return (
    <div className="relative">
      {ep.ready ? (
        <Link
          href={`/s/${serverId}/watch/episode/${ep.id}`}
          className={cn(classes, "pr-24 hover:bg-white/[0.05]")}
        >
          {body}
        </Link>
      ) : (
        <div className={cn(classes, "pr-24 opacity-70")}>{body}</div>
      )}
      <div className="absolute top-2 right-2 flex items-center gap-1.5">
        <MarkDoneButton kind="episode" id={ep.id} done={ep.watched} media="watch" variant="icon" />
        <AddToPlaylistMenu serverId={serverId} target={{ episodeId: ep.id }} variant="icon" />
      </div>
    </div>
  );
}

/** Season pills + the selected season's episode list. */
export function SeasonEpisodes({
  serverId,
  seasons,
  episodes,
  initialSeasonId,
}: {
  serverId: string;
  seasons: SeasonTab[];
  episodes: EpisodeRowData[];
  initialSeasonId: string;
}) {
  const [seasonId, setSeasonId] = useState(initialSeasonId);
  const visible = episodes.filter((e) => e.seasonId === seasonId);

  if (seasons.length === 0) {
    return (
      <p className="px-4 py-10 text-sm text-muted-foreground sm:px-8">
        No seasons found yet.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-5 px-4 pb-16 sm:px-8">
      <div
        role="tablist"
        aria-label="Seasons"
        className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 py-1"
      >
        {seasons.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === seasonId}
            onClick={() => setSeasonId(s.id)}
            className={cn(
              "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
              s.id === seasonId
                ? "bg-primary text-primary-foreground"
                : "bg-white/[0.06] text-muted-foreground ring-1 ring-white/[0.08] hover:bg-white/10 hover:text-foreground"
            )}
          >
            {s.number === 0 ? "Specials" : `Season ${s.number}`}
          </button>
        ))}
      </div>

      {visible.length > 0 && (
        <div>
          <MarkDoneButton key={seasonId} kind="season" id={seasonId} done={visible.some((e) => e.ready) && visible.filter((e) => e.ready).every((e) => e.watched)} media="watch" scope="season" compact />
        </div>
      )}

      <div className="flex flex-col gap-1">
        {visible.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">No episodes in this season yet.</p>
        ) : (
          visible.map((ep) => <EpisodeRow key={ep.id} ep={ep} serverId={serverId} />)
        )}
      </div>
    </section>
  );
}
