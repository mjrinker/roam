"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A titled, horizontally-scrolling shelf of cards (Plex's home-screen rows).
 * Snap-scrolls with touch/trackpad; on desktop, hover arrows page through it.
 * Card widths are set by the children via `itemClassName`-style wrappers.
 */
export function MediaRow({
  title,
  href,
  children,
  className,
}: {
  title: string;
  href?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 8);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [update]);

  function page(direction: 1 | -1) {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: "smooth" });
  }

  return (
    <section className={cn("group/row", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-4 px-4 sm:px-8">
        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">{title}</h2>
        {href && (
          <Link
            href={href}
            className="flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-primary"
          >
            See all <ChevronRight className="size-4" />
          </Link>
        )}
      </div>

      <div className="relative">
        <div
          ref={scroller}
          className="scrollbar-none flex snap-x snap-proximity scroll-pl-4 gap-4 overflow-x-auto scroll-smooth px-4 pt-1 pb-3 sm:scroll-pl-8 sm:px-8 [&>*]:shrink-0 [&>*]:snap-start"
        >
          {children}
        </div>

        {(["left", "right"] as const).map((side) => {
          const enabled = side === "left" ? canLeft : canRight;
          const Icon = side === "left" ? ChevronLeft : ChevronRight;
          return (
            <button
              key={side}
              type="button"
              tabIndex={-1}
              aria-label={side === "left" ? "Scroll left" : "Scroll right"}
              onClick={() => page(side === "left" ? -1 : 1)}
              className={cn(
                "absolute top-[calc(50%-1rem)] z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 text-white opacity-0 shadow-xl ring-1 ring-white/15 backdrop-blur transition hover:scale-105 hover:bg-black/90 md:flex",
                side === "left" ? "left-3" : "right-3",
                enabled && "group-hover/row:opacity-100"
              )}
              disabled={!enabled}
            >
              <Icon className="size-6" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
