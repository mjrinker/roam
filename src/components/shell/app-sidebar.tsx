"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clapperboard, Film, Headphones, House, Settings, Tv, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ServerSwitcher } from "@/components/nav/server-switcher";
import { BrandLogo } from "@/components/shell/brand";
import { useShell } from "@/components/shell/shell-context";
import type { ServerMembershipSummary } from "@/lib/auth/servers";
import type { LibraryKind } from "@/lib/db/schema";

const LIBRARY_ICONS: Record<LibraryKind, React.ComponentType<{ className?: string }>> = {
  movies: Film,
  shows: Tv,
  audiobooks: Headphones,
};

export interface SidebarLibrary {
  id: string;
  name: string;
  kind: LibraryKind;
}

function NavLink({
  href,
  active,
  icon: Icon,
  children,
  onNavigate,
}: {
  href: string;
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-white/[0.08] text-foreground"
          : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
      )}
    >
      {active && (
        <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary" />
      )}
      <Icon
        className={cn(
          "size-[18px] shrink-0 transition-colors",
          active ? "text-primary" : "group-hover:text-foreground"
        )}
      />
      <span className="truncate">{children}</span>
    </Link>
  );
}

export function AppSidebar({
  serverId,
  serverName,
  libraries,
  memberships,
  isAdmin,
}: {
  serverId: string;
  serverName: string;
  libraries: SidebarLibrary[];
  memberships: ServerMembershipSummary[];
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const { drawerOpen, setDrawerOpen } = useShell();
  const close = () => setDrawerOpen(false);
  const home = `/s/${serverId}/library`;

  return (
    <>
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={close}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col gap-5 border-r border-sidebar-border bg-sidebar px-4 py-5 transition-transform duration-200 ease-out",
          "md:sticky md:top-0 md:z-auto md:h-dvh md:w-64 md:shrink-0 md:translate-x-0 md:transition-none",
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center justify-between px-1">
          <Link href={home} onClick={close} aria-label="Roam home" className="flex items-center">
            <BrandLogo variant="teal" className="h-5" />
          </Link>
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/10 hover:text-foreground md:hidden"
          >
            <X className="size-5" />
          </button>
        </div>

        <ServerSwitcher
          memberships={memberships}
          currentServerId={serverId}
          currentServerName={serverName}
        />

        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          <NavLink href={home} icon={House} active={pathname === home} onNavigate={close}>
            Home
          </NavLink>

          <p className="mt-5 mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
            Libraries
          </p>
          {libraries.length === 0 && (
            <p className="px-3 py-1 text-xs text-muted-foreground/70">No libraries yet</p>
          )}
          {libraries.map((lib) => {
            const href = `${home}/${lib.id}`;
            return (
              <NavLink
                key={lib.id}
                href={href}
                icon={LIBRARY_ICONS[lib.kind]}
                active={pathname === href}
                onNavigate={close}
              >
                {lib.name}
              </NavLink>
            );
          })}
        </nav>

        {isAdmin && (
          <div className="border-t border-sidebar-border pt-3">
            <NavLink
              href={`/s/${serverId}/admin`}
              icon={Settings}
              active={pathname.startsWith(`/s/${serverId}/admin`)}
              onNavigate={close}
            >
              Server settings
            </NavLink>
          </div>
        )}

        <p className="flex items-center gap-1.5 px-3 text-[11px] text-muted-foreground/50">
          <Clapperboard className="size-3" /> Roam · private media server
        </p>
      </aside>
    </>
  );
}
