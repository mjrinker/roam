"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

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
  const homeHref = `/s/${serverId}/library`;

  return (
    <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-border px-3 py-6">
      <Link
        href={homeHref}
        className={cn(
          "rounded-md px-3 py-2 text-sm transition-colors",
          pathname === homeHref
            ? "bg-muted font-medium text-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        )}
      >
        Home
      </Link>

      {libraries.length > 0 && (
        <>
          <p className="mt-3 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Libraries
          </p>
          {libraries.map((lib) => {
            const href = `/s/${serverId}/library/${lib.id}`;
            const active = pathname === href;
            return (
              <Link
                key={lib.id}
                href={href}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
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
  );
}
