"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid, LogOut, Settings2, Users } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { ViewerAvatar } from "@/components/profiles/viewer-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({
  email,
  profileName,
  avatarKey,
}: {
  email: string;
  profileName: string;
  avatarKey: string;
}) {
  const router = useRouter();

  async function signOut() {
    // Forget the selected profile too, so the next person to sign in on this device is asked who they are.
    await fetch("/api/viewers/deselect", { method: "POST" }).catch(() => {});
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Profile menu"
        className="rounded-full outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ViewerAvatar avatarKey={avatarKey} size="sm" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <div className="flex items-center gap-3 px-2.5 py-2">
          <ViewerAvatar avatarKey={avatarKey} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{profileName}</p>
            <p className="truncate text-xs text-muted-foreground">{email}</p>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/profiles" />} className="gap-2.5">
          <Users className="size-4 text-muted-foreground" />
          Switch profile
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/profiles?manage=1" />} className="gap-2.5">
          <Settings2 className="size-4 text-muted-foreground" />
          Manage profiles
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/servers" />} className="gap-2.5">
          <LayoutGrid className="size-4 text-muted-foreground" />
          All servers
        </DropdownMenuItem>
        <DropdownMenuItem onClick={signOut} className="gap-2.5">
          <LogOut className="size-4 text-muted-foreground" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
