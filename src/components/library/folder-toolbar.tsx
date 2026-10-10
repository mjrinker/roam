"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Loader2, Search, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { folderLink, parseFolderSearch, parseFolderSort, type FolderSort, type FolderSortKey } from "@/lib/libraries/folder-browse";
import { cn } from "@/lib/utils";

const LABELS: Record<FolderSortKey, string> = { name: "Name", duration: "Duration", artist: "Artist" };

/**
 * A generic Audio library's search box and sort menu, made like the Movies page's. The page itself is read on the server, so each change
 * (after a short pause while typing) opens the matching address instead of filtering in the browser.
 */
export function FolderToolbar({ base, extra, path, sort, q }: { base: string; extra?: string; path: string; sort: FolderSort; q: string | null }) {
  const router = useRouter();
  const [text, setText] = useState(q ?? "");
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function go(nextText: string, nextSort: FolderSort) {
    clearTimeout(timer.current);
    startTransition(() => router.replace(folderLink({ base, extra, path, sort: nextSort, q: parseFolderSearch(nextText) })));
  }
  function type(value: string) {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => go(value, sort), 300);
  }
  // Choosing the sort in use turns it around; choosing another starts it the usual way round.
  function choose(key: FolderSortKey) {
    go(text, key === sort.key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : parseFolderSort(key, null));
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-full sm:w-72">
        {pending ? <Loader2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" /> : <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />}
        <input
          value={text}
          onChange={(e) => type(e.target.value)}
          maxLength={64}
          placeholder="Search this library"
          aria-label="Search this library"
          className="h-10 w-full rounded-xl bg-white/[0.06] pr-9 pl-9 text-sm ring-1 ring-white/[0.08] transition placeholder:text-muted-foreground focus:bg-white/[0.09] focus:ring-2 focus:ring-primary/60 focus:outline-none"
        />
        {text && (
          <button
            type="button"
            onClick={() => {
              setText("");
              go("", sort);
            }}
            aria-label="Clear search"
            className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-white/10 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Sort"
          className="flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-white/[0.06] px-3 text-sm ring-1 ring-white/[0.08] transition outline-none hover:bg-white/[0.09] focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <ArrowUpDown className="size-4 text-muted-foreground" />
          {LABELS[sort.key]}
          {sort.dir === "asc" ? <ArrowUp className="size-3.5 text-primary" /> : <ArrowDown className="size-3.5 text-primary" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          {(Object.keys(LABELS) as FolderSortKey[]).map((k) => (
            <DropdownMenuItem key={k} onClick={() => choose(k)} className="justify-between gap-3">
              <span className="flex items-center gap-2">
                <Check className={cn("size-4", k === sort.key ? "text-primary" : "invisible")} />
                {LABELS[k]}
              </span>
              {k === sort.key && (sort.dir === "asc" ? <ArrowUp className="size-3.5 text-muted-foreground" /> : <ArrowDown className="size-3.5 text-muted-foreground" />)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
