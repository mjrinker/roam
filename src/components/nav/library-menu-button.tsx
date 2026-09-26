"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLibrarySidebar } from "@/components/nav/library-sidebar-context";

/** Mobile-only toggle for the library sidebar drawer — only shown on library pages, since there's nothing to toggle elsewhere. */
export function LibraryMenuButton({ serverId }: { serverId: string }) {
  const pathname = usePathname();
  const { setOpen } = useLibrarySidebar();

  if (!pathname.startsWith(`/s/${serverId}/library`)) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="md:hidden"
      onClick={() => setOpen(true)}
      aria-label="Open libraries menu"
    >
      <Menu className="size-5" />
    </Button>
  );
}
