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
import { RATING_LEVELS } from "@/lib/content/access";
import { canEditExtended } from "@/lib/content/roles";
import type { ViewerRole } from "@/lib/db/schema";

export interface EditableProfile {
  id: string;
  name: string;
  avatarKey: string;
  role: ViewerRole;
  locale: string;
  maxAge: number | null;
  allowUnrated: boolean;
  hasPin: boolean;
}

const RATING_SELECT_VALUE = (v: number | null) => (v === null ? "none" : String(v));
const ASSIGNABLE_ROLES: { value: "admin" | "limited"; label: string; hint: string }[] = [
  { value: "admin", label: "Admin", hint: "Manages their own language, rating limit, and PIN." },
  { value: "limited", label: "Limited", hint: "Can only rename themselves or change their avatar." },
];

/**
 * Create a profile (`profile` null) or edit one.
 *
 * `actor` is the profile CURRENTLY IN USE on this device — not necessarily
 * the one being edited. The owner may edit any profile, including its role;
 * an admin may fully edit only itself; a limited profile editing itself only
 * ever sees name and avatar. See PATCH /api/viewers/[id], which enforces the
 * same rule server-side (this component never has to get it right on its
 * own — the server is the real gate).
 */
export function ProfileEditorDialog({
  profile,
  actor,
  canDelete,
  open,
  onOpenChange,
  onSaved,
}: {
  profile: EditableProfile | null;
  actor: { id: string; role: ViewerRole; hasPin: boolean };
  canDelete: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [avatarKey, setAvatarKey] = useState(profile?.avatarKey ?? DEFAULT_AVATAR_KEY);
  const [role, setRole] = useState<"admin" | "limited">(profile?.role === "admin" ? "admin" : "limited");
  const [locale, setLocale] = useState(profile?.locale ?? DEFAULT_LOCALE);
  const [maxAge, setMaxAge] = useState(profile?.maxAge ?? null);
  const [allowUnrated, setAllowUnrated] = useState(profile?.allowUnrated ?? false);
  const [newPin, setNewPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [busy, setBusy] = useState(false);

  const isOwnerActing = actor.role === "owner";
  // Creating is always an owner action (the route enforces this); editing
  // gets the extended fields when the owner is acting, or when acting on
  // one's own admin profile.
  const canExtend = !profile || canEditExtended(actor, profile.id);
  // The owner assigns a role only when editing someone ELSE — its own role,
  // and anyone editing themselves, never changes here.
  const showRolePicker = isOwnerActing && !!profile && profile.id !== actor.id;

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
    const body: Record<string, unknown> = canExtend
      ? {
          name,
          avatarKey,
          locale,
          maxAge,
          allowUnrated,
          ...(showRolePicker ? { role } : {}),
          ...(newPin.trim() ? { pin: newPin } : {}),
          ...(actor.hasPin ? { currentPin } : {}),
        }
      : { name, avatarKey };

    const ok = await request(profile ? "PATCH" : "POST", body);
    if (!ok) return;
    toast.success(profile ? "Profile saved." : "Profile created.");
    onOpenChange(false);
    onSaved();
  }

  async function removePin() {
    if (!profile) return;
    setBusy(true);
    const res = await fetch(`/api/viewers/${profile.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: null, ...(actor.hasPin ? { currentPin } : {}) }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(typeof data.error === "string" ? data.error : "Couldn't remove the PIN.");
      return;
    }
    toast.success("PIN removed.");
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
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
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

          {profile?.role === "owner" && (
            <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-muted-foreground">
              This is the account owner&apos;s profile — it manages every other profile and can&apos;t be reassigned or
              deleted.
            </p>
          )}

          {showRolePicker && (
            <div className="grid gap-1.5">
              <Label>Role</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {ASSIGNABLE_ROLES.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => setRole(r.value)}
                    className={`rounded-lg p-3 text-left ring-1 transition-colors ${
                      role === r.value ? "bg-primary/10 ring-primary" : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.06]"
                    }`}
                  >
                    <span className="block text-sm font-medium">{r.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{r.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {canExtend && (
            <>
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

              <div className="grid gap-1.5">
                <Label htmlFor="profile-rating">Allowed ratings up to</Label>
                <select
                  id="profile-rating"
                  value={RATING_SELECT_VALUE(maxAge)}
                  onChange={(e) => setMaxAge(e.target.value === "none" ? null : Number(e.target.value))}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {RATING_LEVELS.map((l) => (
                    <option key={RATING_SELECT_VALUE(l.value)} value={RATING_SELECT_VALUE(l.value)} className="bg-popover">
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>

              {maxAge !== null && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={allowUnrated}
                    onChange={(e) => setAllowUnrated(e.target.checked)}
                    className="size-4 rounded border-input"
                  />
                  Allow titles with no rating on file
                </label>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="profile-pin">{profile?.hasPin ? "Change PIN" : "PIN (optional)"}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="profile-pin"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    inputMode="numeric"
                    autoComplete="off"
                    type="password"
                    maxLength={4}
                    placeholder="4 digits"
                    className="max-w-32 text-center tracking-[0.3em]"
                  />
                  {profile?.hasPin && (
                    <Button type="button" variant="ghost" size="sm" onClick={removePin} disabled={busy}>
                      Remove PIN
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {profile?.hasPin
                    ? "A PIN is required to open this profile."
                    : "Require a 4-digit PIN to open this profile."}
                </p>
              </div>

              {actor.hasPin && profile && (
                <div className="grid gap-1.5 rounded-lg bg-white/[0.04] p-3">
                  <Label htmlFor="actor-pin">Confirm your PIN to save</Label>
                  <Input
                    id="actor-pin"
                    value={currentPin}
                    onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    inputMode="numeric"
                    autoComplete="off"
                    type="password"
                    maxLength={4}
                    required
                    className="max-w-32 text-center tracking-[0.3em]"
                  />
                </div>
              )}
            </>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            {profile && canDelete ? (
              <Button type="button" variant="ghost" className="text-destructive" onClick={remove} disabled={busy}>
                Delete profile
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="submit"
              disabled={busy || !name.trim() || (canExtend && actor.hasPin && !!profile && currentPin.length !== 4)}
            >
              {profile ? "Save" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
