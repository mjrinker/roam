"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Download, Loader2, Minus, Plus } from "lucide-react";
import type { Book, NavItem, Rendition } from "epubjs";
import { Button } from "@/components/ui/button";
import { DEFAULT_FONT_INDEX, FONT_KEY, FONT_SIZES, MAX_READER_BYTES, clampFontIndex, keyBelongsToControl, placeKey, validCfi, withBookCsp } from "@/lib/ebooks/reader";

interface TocEntry {
  label: string;
  href: string;
  depth: number;
}

function flatten(items: NavItem[], depth = 0): TocEntry[] {
  return items.flatMap((i) => [{ label: i.label.trim() || "Untitled", href: i.href, depth }, ...(i.subitems ? flatten(i.subitems, depth + 1) : [])]);
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private windows and blocked storage: the place just isn't remembered
  }
};

/**
 * Reads an EPUB in the page. The book is fetched straight from Box with a short-lived address (so its bytes never pass
 * through the app), opened by epub.js, and drawn in an iframe that is sandboxed with scripts OFF: a book can style
 * itself but cannot run code. Place and text size are remembered on this device only.
 */
export function EpubReader({ titleId, viewerId, title, backHref, downloadHref, sizeBytes }: { titleId: string; viewerId: string; title: string; backHref: string; downloadHref: string; sizeBytes: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const rendition = useRef<Rendition | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [fontIndex, setFontIndex] = useState(DEFAULT_FONT_INDEX);

  const tooLarge = sizeBytes !== null && sizeBytes > MAX_READER_BYTES;

  // The saved text size is applied after mount (storage isn't available while rendering on the server).
  useEffect(() => {
    const saved = read(FONT_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads a browser-only value once, after mount
    if (saved !== null) setFontIndex(clampFontIndex(Number(saved)));
  }, []);

  useEffect(() => {
    if (tooLarge) return;
    let cancelled = false;
    let book: Book | null = null;
    const abort = new AbortController();
    (async () => {
      try {
        const urlRes = await fetch(`/api/ebooks/${titleId}/url`, { cache: "no-store", signal: abort.signal });
        if (!urlRes.ok) throw new Error(urlRes.status === 424 ? "This server's Box connection needs to be reconnected by an admin." : "This book isn't available.");
        const { url } = (await urlRes.json()) as { url: string };
        const file = await fetch(url, { signal: abort.signal });
        if (!file.ok) throw new Error("Couldn't load the book from Box.");
        const bytes = await file.arrayBuffer();
        if (cancelled || !box.current) return;

        const { default: ePub } = await import("epubjs");
        if (cancelled || !box.current) return; // left the page while the reader code was loading
        book = ePub(bytes);
        // The book may not fetch anything from the internet (see BOOK_CSP): each page gets the policy before it is drawn. Registered once
        // the book is open so it runs AFTER epub.js's own step that swaps in the book's pictures and styles (each step rewrites the page
        // from what the previous one left in section.output, and the last one wins).
        await book.opened;
        if (cancelled) return;
        book.spine.hooks.serialize.register((_html: string, section: { output: string }) => {
          section.output = withBookCsp(section.output);
        });
        const r = book.renderTo(box.current, { width: "100%", height: "100%", flow: "paginated", spread: "none", allowScriptedContent: false });
        rendition.current = r;
        r.on("rendered", () => box.current?.querySelectorAll("iframe").forEach((f) => f.setAttribute("title", "Book text")));
        r.themes.register("roam", { body: { color: "#e7e7ea !important", background: "#0f1014 !important", "line-height": "1.6 !important" }, "a, a:link": { color: "#7fd8bd !important" }, img: { "max-width": "100% !important" } });
        r.themes.select("roam");
        r.themes.fontSize(`${FONT_SIZES[clampFontIndex(Number(read(FONT_KEY) ?? DEFAULT_FONT_INDEX))]}%`);
        r.on("relocated", (loc: { start: { cfi: string; href: string } }) => {
          write(placeKey(viewerId, titleId), loc.start.cfi);
          setCurrent(loc.start.href.split("#")[0]);
        });
        r.on("keyup", (e: KeyboardEvent) => {
          if (e.key === "ArrowRight") void r.next();
          if (e.key === "ArrowLeft") void r.prev();
        });
        // Swipe on touch screens (the book lives in an iframe, so its touches reach us through epub.js).
        let startX: number | null = null;
        r.on("touchstart", (e: TouchEvent) => (startX = e.changedTouches[0]?.screenX ?? null));
        r.on("touchend", (e: TouchEvent) => {
          const endX = e.changedTouches[0]?.screenX;
          if (startX !== null && endX !== undefined && Math.abs(endX - startX) > 50) void (endX < startX ? r.next() : r.prev());
          startX = null;
        });

        const saved = read(placeKey(viewerId, titleId));
        try {
          await r.display(validCfi(saved) ? saved : undefined);
        } catch {
          // A remembered place that no longer exists in the book (it was replaced): forget it and open at the start.
          write(placeKey(viewerId, titleId), "");
          await r.display();
        }
        const nav = await book.loaded.navigation;
        if (cancelled) return;
        setToc(flatten(nav.toc));
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Couldn't open this book.");
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
      rendition.current?.destroy();
      rendition.current = null;
      book?.destroy();
    };
  }, [titleId, viewerId, tooLarge]);

  const changeFont = useCallback(
    (delta: number) => {
      const next = clampFontIndex(fontIndex + delta);
      setFontIndex(next);
      write(FONT_KEY, String(next));
      rendition.current?.themes.fontSize(`${FONT_SIZES[next]}%`);
    },
    [fontIndex]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keyBelongsToControl(e.target as HTMLElement | null)) return;
      if (e.key === "ArrowRight") void rendition.current?.next();
      if (e.key === "ArrowLeft") void rendition.current?.prev();
    };
    window.addEventListener("keyup", onKey);
    return () => window.removeEventListener("keyup", onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2 sm:px-5">
        <Link href={backHref} className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-foreground" aria-label="Back to the book">
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        {toc.length > 0 && (
          <select
            aria-label="Contents"
            value={toc.find((t) => t.href.split("#")[0] === current)?.href ?? ""}
            onChange={(e) => e.target.value && void rendition.current?.display(e.target.value)}
            className="h-9 max-w-[40vw] rounded-lg bg-white/[0.06] px-2 text-sm"
          >
            <option value="">Contents</option>
            {toc.map((t, i) => (
              <option key={`${i}-${t.href}`} value={t.href}>
                {"  ".repeat(t.depth)}
                {t.label}
              </option>
            ))}
          </select>
        )}
        <div className="flex items-center">
          <Button variant="ghost" size="icon" aria-label="Smaller text" disabled={fontIndex === 0} onClick={() => changeFont(-1)}>
            <Minus className="size-4" />
          </Button>
          <span className="w-10 text-center text-xs text-muted-foreground tabular-nums">{FONT_SIZES[fontIndex]}%</span>
          <Button variant="ghost" size="icon" aria-label="Larger text" disabled={fontIndex === FONT_SIZES.length - 1} onClick={() => changeFont(1)}>
            <Plus className="size-4" />
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={box} className="absolute inset-x-0 inset-y-0 mx-auto w-full max-w-3xl px-6 py-4 sm:px-10" />
        {status === "loading" && !tooLarge && (
          <div className="absolute inset-0 flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" /> Opening the book…
          </div>
        )}
        {(status === "error" || tooLarge) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <p role="alert" className="max-w-sm text-sm text-muted-foreground">
              {tooLarge ? "This book is too large to read here. Download it instead." : message}
            </p>
            <a href={downloadHref} className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground">
              <Download className="size-4" /> Download
            </a>
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-white/10 px-3 py-2 sm:px-5">
        <Button variant="ghost" size="sm" className="gap-1" disabled={status !== "ready"} onClick={() => void rendition.current?.prev()}>
          <ChevronLeft className="size-4" /> Previous
        </Button>
        <Button variant="ghost" size="sm" className="gap-1" disabled={status !== "ready"} onClick={() => void rendition.current?.next()}>
          Next <ChevronRight className="size-4" />
        </Button>
      </footer>
    </div>
  );
}
