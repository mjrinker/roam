import Link from "next/link";
import { requireServerMember } from "@/lib/auth/guards";
import { listServerMemberships } from "@/lib/auth/servers";
import { SignOutButton } from "@/components/nav/sign-out-button";
import { ServerSwitcher } from "@/components/nav/server-switcher";

export default async function ServerLayout({
  children,
  params,
}: LayoutProps<"/s/[serverId]">) {
  const { serverId } = await params;
  const { profile, role } = await requireServerMember(serverId);
  const memberships = await listServerMemberships(profile.id);
  const current = memberships.find((m) => m.serverId === serverId);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
        <nav className="flex items-center gap-6">
          <Link href={`/s/${serverId}/library`} className="text-lg font-semibold tracking-tight">
            Roam
          </Link>
          <ServerSwitcher
            memberships={memberships}
            currentServerId={serverId}
            currentServerName={current?.serverName ?? "Server"}
          />
          <Link
            href={`/s/${serverId}/library`}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Library
          </Link>
          {role === "admin" && (
            <Link
              href={`/s/${serverId}/admin`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Admin
            </Link>
          )}
        </nav>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {profile.displayName ?? profile.email}
          </span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
