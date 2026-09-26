"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid, LogOut } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function initials(nameOrEmail: string) {
  const base = nameOrEmail.split("@")[0];
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = (parts.length > 1 ? parts[0][0] + parts[1][0] : base.slice(0, 2)) || "?";
  return letters.toUpperCase();
}

export function UserMenu({ email, displayName }: { email: string; displayName: string | null }) {
  const router = useRouter();
  const label = displayName ?? email;

  async function signOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="rounded-full outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar size="lg" className="ring-1 ring-white/15">
          <AvatarFallback className="bg-gradient-to-br from-primary/90 to-[oklch(0.68_0.16_55)] text-sm font-semibold text-primary-foreground">
            {initials(label)}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <div className="px-2.5 py-2">
          <p className="truncate text-sm font-medium">{label}</p>
          {displayName && <p className="truncate text-xs text-muted-foreground">{email}</p>}
        </div>
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
