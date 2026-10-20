"use client";

import { setOfflineViewer } from "@/lib/offline/viewer";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleHelp, Database, Gauge, LayoutGrid, LogOut, MessageSquarePlus, Settings2, Users } from "lucide-react";
import { DataSaverDialog } from "@/components/shell/data-saver-dialog";
import { YourDataDialog } from "@/components/shell/your-data-dialog";
import { FeedbackDialog } from "@/components/feedback/feedback-dialog";
import { useDataSaverState } from "@/components/ui/data-saver-context";
import { describeDataSaver } from "@/lib/player/data-saver-mode";
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
  serverId,
  email,
  profileName,
  avatarKey,
  isAdmin = false,
}: {
  serverId: string;
  email: string;
  profileName: string;
  avatarKey: string;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [saverOpen, setSaverOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const saver = useDataSaverState();

  async function signOut() {
    setOfflineViewer(null);
    // Forget the selected profile too, so the next person to sign in on this device is asked who they are.
    await fetch("/api/viewers/deselect", { method: "POST" }).catch(() => {});
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <>
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
        <DropdownMenuItem onClick={() => setSaverOpen(true)} className="gap-2.5">
          <Gauge className="size-4 text-muted-foreground" />
          <span className="min-w-0">
            Data saver
            <span className="block truncate text-xs text-muted-foreground">{describeDataSaver(saver.mode, saver.profileOn, saver.metered)}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setDataOpen(true)} className="gap-2.5">
          <Database className="size-4 text-muted-foreground" />
          Your data
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/help" />} className="gap-2.5">
          <CircleHelp className="size-4 text-muted-foreground" />
          Help
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setFeedbackOpen(true)} className="gap-2.5">
          <MessageSquarePlus className="size-4 text-muted-foreground" />
          Send feedback
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href={`/s/${serverId}/feedback`} />} className="gap-2.5">
          <MessageSquarePlus className="size-4 text-muted-foreground" />
          Feedback board
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
    <DataSaverDialog open={saverOpen} onOpenChange={setSaverOpen} />
    <FeedbackDialog serverId={serverId} open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    <YourDataDialog serverId={serverId} open={dataOpen} onOpenChange={setDataOpen} isAdmin={isAdmin} />
    </>
  );
}
