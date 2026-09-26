"use client";

import Link from "next/link";
import { Check, ChevronsUpDown, Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ServerMembershipSummary } from "@/lib/auth/servers";

export function ServerTile({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-secondary text-sm font-semibold uppercase text-foreground ring-1 ring-white/10 ${className}`}
      aria-hidden="true"
    >
      {name.trim().charAt(0) || "R"}
    </span>
  );
}

export function ServerSwitcher({
  memberships,
  currentServerId,
  currentServerName,
}: {
  memberships: ServerMembershipSummary[];
  currentServerId: string;
  currentServerName: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2.5 rounded-xl bg-white/[0.04] p-2 text-left ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-white/[0.08]"
      >
        <ServerTile name={currentServerName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-tight">
            {currentServerName}
          </span>
          <span className="block text-[11px] leading-tight text-muted-foreground">
            Switch server
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.serverId}
            render={<Link href={`/s/${m.serverId}/library`} />}
            className="gap-2.5"
          >
            <ServerTile name={m.serverName} className="size-6 rounded-md text-xs" />
            <span className="flex-1 truncate">{m.serverName}</span>
            {m.serverId === currentServerId && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/servers" />} className="gap-2.5">
          <Settings2 className="size-4 text-muted-foreground" />
          Manage servers
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
