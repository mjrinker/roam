"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AvatarPicker } from "@/components/profiles/avatar-picker";
import { ViewerAvatar } from "@/components/profiles/viewer-avatar";
import { DEFAULT_AVATAR_KEY } from "@/lib/viewers/avatars";
import { VIEWER_NAME_MAX_LENGTH } from "@/lib/viewers/config";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/viewers/locales";

export interface EditableProfile {
  id: string;
  name: string;
  avatarKey: string;
  locale: string;
  hasPin: boolean;
}

/** Create a profile (`profile` null) or edit one. */
export function ProfileEditorDialog({
  profile,
  canDelete,
  open,
  onOpenChange,
  onSaved,
}: {
  profile: EditableProfile | null;
  canDelete: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [avatarKey, setAvatarKey] = useState(profile?.avatarKey ?? DEFAULT_AVATAR_KEY);
  const [locale, setLocale] = useState(profile?.locale ?? DEFAULT_LOCALE);
  const [busy, setBusy] = useState(false);

  async function request(method: "POST" | "PATCH" | "DELETE", body?: object) {
    setBusy(true);
    const res = await fetch(profile ? `/api/viewers/${profile.id}` : "/api/viewers", {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(typeof data.error === "string" ? data.error : "Something went wrong.");
      return false;
    }
    return true;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await request(profile ? "PATCH" : "POST", { name, avatarKey, locale });
    if (!ok) return;
    toast.success(profile ? "Profile saved." : "Profile created.");
    onOpenChange(false);
    onSaved();
  }

  async function remove() {
    if (!profile || !window.confirm(`Delete ${profile.name}'s profile? Their watch history goes with it.`)) return;
    if (!(await request("DELETE"))) return;
    toast.success("Profile deleted.");
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{profile ? "Edit profile" : "Add profile"}</DialogTitle>
            <DialogDescription>Each profile keeps its own watch history and settings.</DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-4">
            <ViewerAvatar avatarKey={avatarKey} size="lg" />
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                value={name}
                maxLength={VIEWER_NAME_MAX_LENGTH}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Avatar</Label>
            <AvatarPicker value={avatarKey} onChange={setAvatarKey} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="profile-locale">Language and region</Label>
            <select
              id="profile-locale"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {LOCALES.map((l) => (
                <option key={l.tag} value={l.tag} className="bg-popover">
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {profile && canDelete ? (
              <Button type="button" variant="ghost" className="text-destructive" onClick={remove} disabled={busy}>
                Delete profile
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={busy || !name.trim()}>
              {profile ? "Save" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
