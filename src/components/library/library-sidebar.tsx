"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface LibraryNavItem {
  id: string;
  name: string;
  kind: "movies" | "shows";
}

export function LibrarySidebar({
  serverId,
  libraries,
}: {
  serverId: string;
  libraries: LibraryNavItem[];
}) {
  const pathname = usePathname();
  // Collapsed by default on mobile (a drawer toggled open/closed); on
  // desktop (md: and up) the sidebar ignores this and is always visible —
  // see the responsive classes below.
  const [open, setOpen] = useState(false);
  const homeHref = `/s/${serverId}/library`;

  function linkClasses(active: boolean) {
    return cn(
      "flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors",
      active
        ? "bg-muted font-medium text-foreground"
        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
    );
  }

  return (
    <>
      {/* Mobile-only bar with the toggle — desktop shows the sidebar directly. */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
        <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open libraries menu">
          <Menu className="size-5" />
        </Button>
        <span className="text-sm font-medium text-muted-foreground">Libraries</span>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <nav
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-background px-3 py-6 transition-transform duration-200",
          "md:static md:z-auto md:w-52 md:translate-x-0 md:transition-none",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="mb-2 flex items-center justify-between md:hidden">
          <span className="text-sm font-semibold">Libraries</span>
          <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close menu">
            <X className="size-4" />
          </Button>
        </div>

        <Link href={homeHref} onClick={() => setOpen(false)} className={linkClasses(pathname === homeHref)}>
          Home
        </Link>

        {libraries.length > 0 && (
          <>
            <p className="mt-3 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Libraries
            </p>
            {libraries.map((lib) => {
              const href = `/s/${serverId}/library/${lib.id}`;
              return (
                <Link
                  key={lib.id}
                  href={href}
                  onClick={() => setOpen(false)}
                  className={linkClasses(pathname === href)}
                >
                  <span className="truncate">{lib.name}</span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {lib.kind === "movies" ? "Movies" : "TV"}
                  </Badge>
                </Link>
              );
            })}
          </>
        )}
      </nav>
    </>
  );
}
