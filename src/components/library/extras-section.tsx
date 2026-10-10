import Link from "next/link";
import { Play } from "lucide-react";
import { EXTRA_LABELS, type ExtraCategory } from "@/lib/extras/categories";
import type { ExtraItem } from "@/lib/extras/load";
import { formatRuntime } from "@/lib/format";

/** A movie's trailers and other extras under its header, one list per type; each plays in the usual player. */
export function ExtrasSection({ serverId, groups }: { serverId: string; groups: { category: ExtraCategory; items: ExtraItem[] }[] }) {
  if (groups.length === 0) return null;
  return (
    <section aria-label="Extras" className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 pt-8 pb-16 sm:px-8">
      {groups.map(({ category, items }) => (
        <div key={category} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">{EXTRA_LABELS[category]}</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/s/${serverId}/watch/extra/${item.id}`}
                  className="group/extra flex min-w-0 items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2.5 ring-1 ring-white/[0.08] transition hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Play className="size-4" fill="currentColor" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatRuntime(item.durationSeconds) ?? ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
