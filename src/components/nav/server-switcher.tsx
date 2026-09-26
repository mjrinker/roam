"use client";

import Link from "next/link";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ServerMembershipSummary } from "@/lib/auth/servers";

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
        render={
          <Button variant="ghost" size="sm" className="gap-1.5">
            <span className="max-w-40 truncate">{currentServerName}</span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.serverId}
            disabled={m.serverId === currentServerId}
            render={<Link href={`/s/${m.serverId}/library`} />}
          >
            {m.serverName}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/servers" />}>
          Manage servers…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
