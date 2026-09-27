"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PinDialog } from "@/components/profiles/pin-dialog";
import { ProfileEditorDialog, type EditableProfile } from "@/components/profiles/profile-editor-dialog";
import { ViewerAvatar } from "@/components/profiles/viewer-avatar";

/** Only same-site relative paths, so the `next` param can't bounce someone to another site. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** The "Who's watching?" tiles, with a manage mode for editing and adding profiles. */
export function ProfilePicker({
  profiles,
  canAdd,
  canDelete,
  next,
  startInManage,
}: {
  profiles: EditableProfile[];
  canAdd: boolean;
  canDelete: boolean;
  next: string | null;
  startInManage: boolean;
}) {
  const router = useRouter();
  const [managing, setManaging] = useState(startInManage);
  const [pinFor, setPinFor] = useState<EditableProfile | null>(null);
  const [editing, setEditing] = useState<EditableProfile | "new" | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);

  async function choose(profile: EditableProfile, pin?: string): Promise<string | null> {
    setChoosing(profile.id);
    const res = await fetch(`/api/viewers/${profile.id}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      setChoosing(null);
      const body = await res.json().catch(() => ({}));
      return typeof body.error === "string" ? body.error : "Couldn't open that profile.";
    }
    // A full navigation (not router.push) so the audio player resets and nothing
    // keeps playing for the previous profile.
    window.location.assign(safeNext(next));
    return null;
  }

  async function onTileClick(profile: EditableProfile) {
    if (managing) return setEditing(profile);
    if (profile.hasPin) return setPinFor(profile);
    const error = await choose(profile);
    if (error) toast.error(error);
  }

  return (
    <div className="flex flex-col items-center gap-10">
      <ul className="flex flex-wrap items-start justify-center gap-6 sm:gap-8">
        {profiles.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onTileClick(p)}
              disabled={choosing !== null}
              className="group flex w-28 flex-col items-center gap-3 rounded-2xl p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:w-36"
            >
              <span className="relative">
                <ViewerAvatar
                  avatarKey={p.avatarKey}
                  size="xl"
                  className={cn("transition duration-200 group-hover:scale-105 group-hover:ring-2 group-hover:ring-white/60", choosing === p.id && "animate-pulse")}
                />
                {managing && (
                  <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55">
                    <Pencil className="size-7 text-white" />
                  </span>
                )}
                {!managing && p.hasPin && (
                  <span className="absolute right-0 bottom-0 flex size-7 items-center justify-center rounded-full bg-background ring-1 ring-white/20">
                    <Lock className="size-3.5 text-muted-foreground" />
                  </span>
                )}
              </span>
              <span className="w-full truncate text-center text-sm text-muted-foreground transition-colors group-hover:text-foreground sm:text-base">
                {p.name}
              </span>
            </button>
          </li>
        ))}

        {canAdd && managing && profiles.length < 6 && (
          <li>
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="group flex w-28 flex-col items-center gap-3 rounded-2xl p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-36"
            >
              <span className="flex size-28 items-center justify-center rounded-full bg-white/[0.06] ring-1 ring-white/15 transition group-hover:bg-white/10 sm:size-32">
                <Plus className="size-12 text-muted-foreground" />
              </span>
              <span className="text-sm text-muted-foreground sm:text-base">Add profile</span>
            </button>
          </li>
        )}
      </ul>

      <Button variant={managing ? "default" : "outline"} onClick={() => setManaging((m) => !m)} className="rounded-xl px-6">
        {managing ? "Done" : "Manage profiles"}
      </Button>

      {pinFor && (
        <PinDialog
          profileName={pinFor.name}
          open
          onOpenChange={(open) => !open && setPinFor(null)}
          onSubmit={(pin) => choose(pinFor, pin)}
        />
      )}

      {editing && (
        <ProfileEditorDialog
          profile={editing === "new" ? null : editing}
          canDelete={canDelete && profiles.length > 1}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={() => router.refresh()}
        />
      )}
    </div>
  );
}
