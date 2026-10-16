"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { ArtistCard } from "@/lib/music/browse";
import { ArtistTile, TILE_GRID } from "@/components/music/music-cards";

export interface AboutData {
  found: boolean;
  summary: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  licenseUrl: string;
  similarInLibrary?: ArtistCard[];
  similarElsewhere?: string[];
}

/** The description and (for an artist) similar artists, as they are drawn. Pure, so it can be tested without fetching. */
export function AboutView({ serverId, kind, data }: { serverId: string; kind: "artist" | "album"; data: AboutData }) {
  const [open, setOpen] = useState(false);
  const similar = data.similarInLibrary ?? [];
  const others = data.similarElsewhere ?? [];
  if (!data.found || (!data.summary && similar.length === 0 && others.length === 0)) return null;
  const long = (data.summary?.length ?? 0) > 420;
  return (
    <div className="flex flex-col gap-6">
      {data.summary && (
        <section className="flex max-w-3xl flex-col gap-2">
          <h2 className="text-lg font-semibold tracking-tight">About {kind === "artist" ? "this artist" : "this album"}</h2>
          <p className={cn("text-sm leading-relaxed text-muted-foreground", long && !open && "line-clamp-4")}>{data.summary}</p>
          {long && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="self-start text-xs font-medium text-primary hover:underline">
              {open ? "Show less" : "Read more"}
            </button>
          )}
          {data.sourceUrl && (
            <p className="text-xs text-muted-foreground/80">
              From{" "}
              <a href={data.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
                {data.sourceTitle ? `“${data.sourceTitle}” on Wikipedia` : "Wikipedia"}
              </a>
              , under{" "}
              <a href={data.licenseUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
                CC BY-SA 4.0
              </a>
              .
            </p>
          )}
        </section>
      )}
      {(similar.length > 0 || others.length > 0) && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Similar artists</h2>
          {similar.length > 0 && (
            <div className={TILE_GRID}>
              {similar.map((a) => (
                <ArtistTile key={a.id} serverId={serverId} artist={a} />
              ))}
            </div>
          )}
          {others.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {similar.length > 0 ? "Also similar, not in this library: " : "Listeners also play: "}
              {others.join(", ")}.
            </p>
          )}
          <p className="text-xs text-muted-foreground/80">Based on what people who listen to this artist also listen to (ListenBrainz).</p>
        </section>
      )}
    </div>
  );
}

/** Looks up the description when the page opens and draws it when there is one (nothing at all otherwise, and while it loads). */
export function AboutSection({ serverId, kind, id }: { serverId: string; kind: "artist" | "album"; id: string }) {
  const [data, setData] = useState<AboutData | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/music/about/${kind}/${id}`)
      .then((res) => (res.ok ? (res.json() as Promise<AboutData>) : null))
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kind, id]);
  return data ? <AboutView serverId={serverId} kind={kind} data={data} /> : null;
}
