"use client";

import { Menu } from "lucide-react";
import { BackButton } from "@/components/shell/back-button";
import { BrandLogo } from "@/components/shell/brand";
import { SearchBox } from "@/components/shell/search-box";
import { UserMenu } from "@/components/shell/user-menu";
import { useShell } from "@/components/shell/shell-context";

export function TopBar({
  serverId,
  email,
  profileName,
  avatarKey,
}: {
  serverId: string;
  email: string;
  profileName: string;
  avatarKey: string;
}) {
  const { setDrawerOpen } = useShell();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/[0.05] bg-background/70 px-4 backdrop-blur-xl sm:px-6">
      <BackButton serverId={serverId} />
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open menu"
        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground md:hidden"
      >
        <Menu className="size-5" />
      </button>
      <BrandLogo variant="teal" className="hidden h-4 sm:block md:hidden" />

      <div className="flex flex-1 justify-center md:justify-start">
        <SearchBox serverId={serverId} />
      </div>

      <UserMenu email={email} profileName={profileName} avatarKey={avatarKey} />
    </header>
  );
}
