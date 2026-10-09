"use client";

import { useRouter } from "next/navigation";
import { Film, Loader2, Maximize2, Pause, Play, RotateCcw, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/player/timeline";
import { progressPercent } from "@/components/player/video-session-state";
import { useVideoSession, useVideoSessionActions } from "@/components/player/video-session";

export const STEP_SECONDS = 10;

function BarButton({ label, className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", className)}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * The floating bar a video shrinks into when you leave the player: it stays over every page and the video keeps playing (sound only).
 * Title, step back and forward, play or pause, a button to bring the player back, and one to close it.
 */
export function FloatingVideoBar() {
  const router = useRouter();
  const view = useVideoSession();
  const actions = useVideoSessionActions();
  if (!view?.session || !actions) return null;
  const { session, status } = view;
  const finished = !!status?.finished;
  const failed = !!status?.error && !status.ready;
  const busy = !status?.ready || (!!status?.buffering && !!status?.playing);
  const expand = () => router.push(session.watchHref);
  const line = failed ? status?.error : finished ? "Finished" : [session.subtitle, status && status.duration > 0 ? `${formatClock(status.time)} / ${formatClock(status.duration)}` : null].filter(Boolean).join(" · ");

  return (
    <div role="region" aria-label="Now playing" className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-background/90 shadow-2xl backdrop-blur-xl sm:inset-x-6">
      <div role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressPercent(status?.time ?? 0, status?.duration ?? 0))} className="h-1 bg-white/15">
        <div className="h-full bg-primary" style={{ width: `${progressPercent(status?.time ?? 0, status?.duration ?? 0)}%` }} />
      </div>
      <div className="flex items-center gap-1.5 px-3 py-2.5 sm:gap-2">
        <button type="button" onClick={expand} aria-label={`Open the player for ${session.title}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.08] ring-1 ring-white/10">
            <Film className="size-5 text-primary" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{session.title}</span>
            {line && <span className="block truncate text-xs text-muted-foreground tabular-nums">{line}</span>}
          </span>
        </button>

        {!finished && !failed && (
          <>
            <BarButton label={`Back ${STEP_SECONDS} seconds`} onClick={() => actions.skip(-STEP_SECONDS)} disabled={busy && !status?.ready}>
              <RotateCcw className="size-5" />
            </BarButton>
            <button
              type="button"
              aria-label={status?.playing ? "Pause" : "Play"}
              title={status?.playing ? "Pause" : "Play"}
              onClick={actions.toggle}
              disabled={!status?.ready}
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow transition hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-5 animate-spin" /> : status?.playing ? <Pause className="size-5" fill="currentColor" /> : <Play className="ml-0.5 size-5" fill="currentColor" />}
            </button>
            <BarButton label={`Forward ${STEP_SECONDS} seconds`} onClick={() => actions.skip(STEP_SECONDS)} disabled={!status?.ready}>
              <RotateCw className="size-5" />
            </BarButton>
          </>
        )}
        <BarButton label="Open the player" onClick={expand}>
          <Maximize2 className="size-[18px]" />
        </BarButton>
        <BarButton label="Close the player" onClick={actions.close}>
          <X className="size-5" />
        </BarButton>
      </div>
    </div>
  );
}

/** Room at the end of a page for the floating bar, only while it is showing. */
export function PlayerBarSpacer() {
  const view = useVideoSession();
  return view?.session && !view.expanded ? <div aria-hidden className="h-24" /> : null;
}
