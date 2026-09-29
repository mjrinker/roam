import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Crumb {
  label: string;
  /** Omit on the current page. */
  href?: string;
}

/** Home is always the first crumb; pages pass the rest, current page last. */
export function Breadcrumbs({
  serverId,
  trail,
  className,
}: {
  serverId: string;
  trail: Crumb[];
  className?: string;
}) {
  const items: Crumb[] = [{ label: "Home", href: `/s/${serverId}/library` }, ...trail];
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0 text-sm text-muted-foreground", className)}>
      <ol className="flex min-w-0 items-center gap-1.5">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className={cn("flex items-center gap-1.5", last ? "min-w-0" : "shrink-0")}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden />}
              {item.href && !last ? (
                <Link href={item.href} className="transition-colors hover:text-foreground">
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn("truncate", last && "text-foreground")}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
