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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AvatarPicker } from "@/components/profiles/avatar-picker";
import { ViewerAvatar } from "@/components/profiles/viewer-avatar";
import { DEFAULT_AVATAR_KEY } from "@/lib/viewers/avatars";
import { VIEWER_NAME_MAX_LENGTH } from "@/lib/viewers/config";
import { MEDIA_LANGUAGES } from "@/lib/viewers/audio-languages";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/viewers/locales";
import { RATING_LEVELS } from "@/lib/content/access";
import { canEditExtended } from "@/lib/content/roles";
import type { ViewerRole } from "@/lib/db/schema";
import { normalizeAutoSkip, type AutoSkipPrefs } from "@/lib/skipdb/active";
import { CATEGORY_LABELS, FILTER_CATEGORIES, isFilterSeverity, type ContentFilterPrefs } from "@/lib/content-filter/categories";

export interface EditableProfile {
  id: string;
  name: string;
  avatarKey: string;
  role: ViewerRole;
  locale: string;
  maxAge: number | null;
  allowUnrated: boolean;
  visibleOnServer: boolean;
  contentFilter: ContentFilterPrefs;
  autoSkip: AutoSkipPrefs;
  groupCollections: boolean;
  dataSaver: boolean;
  /** Screen time: a daily limit in minutes and quiet hours (minutes after midnight), on the clock of timeZone; all null = none. */
  screenTimeMinutes: number | null;
  quietFrom: number | null;
  quietTo: number | null;
  timeZone: string | null;
  /** ISO 639-2 codes ("eng"), or null for no preference. */
  audioLanguage: string | null;
  subtitleLanguage: string | null;
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
  const [visibleOnServer, setVisibleOnServer] = useState(profile?.visibleOnServer ?? true);
  const [contentFilter, setContentFilter] = useState<ContentFilterPrefs>(profile?.contentFilter ?? {});
  const [autoSkip, setAutoSkip] = useState<AutoSkipPrefs>(profile?.autoSkip ?? {});
  const [groupCollections, setGroupCollections] = useState(profile?.groupCollections ?? false);
  const [dataSaver, setDataSaver] = useState(profile?.dataSaver ?? false);
  const [screenLimit, setScreenLimit] = useState<number | null>(profile?.screenTimeMinutes ?? null);
  const [quietOn, setQuietOn] = useState(profile?.quietFrom != null && profile?.quietTo != null);
  const [quietFrom, setQuietFrom] = useState(profile?.quietFrom ?? 21 * 60);
  const [quietTo, setQuietTo] = useState(profile?.quietTo ?? 7 * 60);
  const [audioLanguage, setAudioLanguage] = useState(profile?.audioLanguage ?? "");
  const [subtitleLanguage, setSubtitleLanguage] = useState(profile?.subtitleLanguage ?? "");
  const [newPin, setNewPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [busy, setBusy] = useState(false);

  const isOwnerActing = actor.role === "owner";
  // Creating is always an owner action (the route enforces this); editing
  // gets the extended fields when the owner is acting, or when acting on
  // one's own admin profile.
  const canExtend = !profile || canEditExtended(actor, profile.id);
  // The owner picks a role when creating a profile, or editing someone ELSE's
  // — never its own (self-editing, including the owner, never changes this
  // here). Creating is always an owner action (the route enforces it), so no
  // extra isOwnerActing check is needed for that branch.
  const showRolePicker = !profile || (isOwnerActing && profile.id !== actor.id);

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
          visibleOnServer,
          contentFilter,
          autoSkip: normalizeAutoSkip(autoSkip),
          groupCollections,
          dataSaver,
          screenTimeMinutes: screenLimit,
          quietFrom: quietOn ? quietFrom : null,
          quietTo: quietOn ? quietTo : null,
          // The limit and quiet hours run on this device's clock (a device in another zone, as on holiday, doesn't move them).
          ...(screenLimit !== null || quietOn ? { timeZone: profile?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
          audioLanguage: audioLanguage || null,
          subtitleLanguage: subtitleLanguage || null,
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

  const FILTER_STRENGTHS = [
    ["off", "Don't skip"],
    ["high", "Skip strong"],
    ["medium", "Skip moderate and up"],
    ["low", "Skip all, even mild"],
  ] as const;
  const filtered = FILTER_CATEGORIES.filter((c) => contentFilter[c]).length;
  const autoSkipCount = Object.values(normalizeAutoSkip(autoSkip)).filter(Boolean).length;
  const setAllFilters = (value: string) => setContentFilter(value === "off" ? {} : Object.fromEntries(FILTER_CATEGORIES.map((c) => [c, value])) as ContentFilterPrefs);
  const select = "h-9 rounded-md border border-input bg-transparent px-3 text-sm";
  const check = "flex items-start gap-2 text-sm";

  const profileFields = (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex items-center gap-4">
        <ViewerAvatar avatarKey={avatarKey} size="lg" />
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="profile-name">Name</Label>
          <Input id="profile-name" value={name} maxLength={VIEWER_NAME_MAX_LENGTH} onChange={(e) => setName(e.target.value)} autoFocus required />
        </div>
      </div>
      <div className="grid gap-2">
        <Label>Avatar</Label>
        <AvatarPicker value={avatarKey} onChange={setAvatarKey} />
      </div>

      {profile?.role === "owner" && (
        <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-muted-foreground">
          This is the account owner&apos;s profile: it manages every other profile and can&apos;t be reassigned or deleted.
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
                className={`rounded-lg p-3 text-left ring-1 transition-colors ${role === r.value ? "bg-primary/10 ring-primary" : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.06]"}`}
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
            <p className="text-xs text-muted-foreground">{profile?.hasPin ? "A PIN is required to open this profile." : "Ask for a 4-digit PIN to open this profile."}</p>
          </div>

          <label className={check}>
            <input type="checkbox" checked={visibleOnServer} onChange={(e) => setVisibleOnServer(e.target.checked)} className="mt-0.5 size-4 rounded border-input" />
            <span>
              Show this profile to other members of the server
              {profile && profile.visibleOnServer && !visibleOnServer && (
                <span className="block text-xs text-muted-foreground">Hiding it also removes its access to playlists others shared with it; showing it again won&apos;t bring those back.</span>
              )}
            </span>
          </label>
        </>
      )}
    </div>
  );

  const watching = (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="profile-locale">Language and region</Label>
        <select id="profile-locale" value={locale} onChange={(e) => setLocale(e.target.value)} className={select}>
          {LOCALES.map((l) => (
            <option key={l.tag} value={l.tag} className="bg-popover">
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="profile-rating">Allowed ratings up to</Label>
        <select id="profile-rating" value={RATING_SELECT_VALUE(maxAge)} onChange={(e) => setMaxAge(e.target.value === "none" ? null : Number(e.target.value))} className={select}>
          {RATING_LEVELS.map((l) => (
            <option key={RATING_SELECT_VALUE(l.value)} value={RATING_SELECT_VALUE(l.value)} className="bg-popover">
              {l.label}
            </option>
          ))}
        </select>
        {maxAge !== null && (
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowUnrated} onChange={(e) => setAllowUnrated(e.target.checked)} className="size-4 rounded border-input" />
            Allow titles with no rating on file
          </label>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="profile-audio-language">Audio language</Label>
          <select id="profile-audio-language" value={audioLanguage} onChange={(e) => setAudioLanguage(e.target.value)} className={select}>
            <option value="" className="bg-popover">The file&apos;s default</option>
            {MEDIA_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code} className="bg-popover">{l.label}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="profile-subtitle-language">Subtitles</Label>
          <select id="profile-subtitle-language" value={subtitleLanguage} onChange={(e) => setSubtitleLanguage(e.target.value)} className={select}>
            <option value="" className="bg-popover">Off</option>
            {MEDIA_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code} className="bg-popover">{l.label}</option>
            ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">Used automatically when a video has that audio or those subtitles inside it. Picking one in the player sets these too.</p>
      </div>

      <fieldset className="grid min-w-0 gap-2 rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/10">
        <legend className="px-1 text-sm font-medium">Screen time</legend>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="screen-limit" className="font-normal">Daily limit</Label>
          <select id="screen-limit" value={screenLimit ?? ""} onChange={(e) => setScreenLimit(e.target.value === "" ? null : Number(e.target.value))} className="h-8 rounded-md border border-input bg-transparent px-2 text-sm">
            <option value="" className="bg-popover">No limit</option>
            {[30, 60, 90, 120, 180, 240].map((m) => (
              <option key={m} value={m} className="bg-popover">{m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={quietOn} onChange={(e) => setQuietOn(e.target.checked)} className="size-4 rounded border-input" />
          Quiet hours: no watching between
        </label>
        {quietOn && (
          <div className="flex items-center gap-2 text-sm">
            <input type="time" aria-label="Quiet hours start" value={`${String(Math.floor(quietFrom / 60)).padStart(2, "0")}:${String(quietFrom % 60).padStart(2, "0")}`} onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); if (Number.isFinite(h) && Number.isFinite(m)) setQuietFrom(h * 60 + m); }} className="h-8 rounded-md border border-input bg-transparent px-2" />
            and
            <input type="time" aria-label="Quiet hours end" value={`${String(Math.floor(quietTo / 60)).padStart(2, "0")}:${String(quietTo % 60).padStart(2, "0")}`} onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); if (Number.isFinite(h) && Number.isFinite(m)) setQuietTo(h * 60 + m); }} className="h-8 rounded-md border border-input bg-transparent px-2" />
          </div>
        )}
        <p className="text-xs text-muted-foreground">When the time is up, or in quiet hours, this profile can&apos;t start a video and one playing stops. Counted on this device&apos;s clock.</p>
      </fieldset>

      <label className={check}>
        <input type="checkbox" checked={groupCollections} onChange={(e) => setGroupCollections(e.target.checked)} className="mt-0.5 size-4 rounded border-input" />
        <span>
          Group collections in lists
          <span className="block text-xs text-muted-foreground">A film series shows as one tile in Movies and TV Shows. Searching and filtering still show every title.</span>
        </span>
      </label>

      <label className={check}>
        <input type="checkbox" checked={dataSaver} onChange={(e) => setDataSaver(e.target.checked)} className="mt-0.5 size-4 rounded border-input" />
        <span>
          Data saver
          <span className="block text-xs text-muted-foreground">For a limited data plan: video at about 480p unless you pick another quality, lower-quality pictures, and no loading the next song ahead.</span>
        </span>
      </label>
    </div>
  );

  const skipping = (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <fieldset className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
        <legend className="text-sm font-medium">Skip automatically</legend>
        <p className="-mt-1 text-xs text-muted-foreground">Move on by itself, where a show has the times, instead of showing a button.</p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {([["intro", "Intros"], ["recap", "Recaps"], ["preview", "Next-time previews"], ["outro", "Credits (then next episode)"]] as const).map(([kind, label]) => (
            <label key={kind} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={autoSkip[kind] === true} onChange={(e) => setAutoSkip({ ...autoSkip, [kind]: e.target.checked })} className="size-4 rounded border-input" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        <legend className="text-sm font-medium">Skip scenes</legend>
        <p className="-mt-1 text-xs text-muted-foreground">For movies and shows that come with a content filter file, scenes in these categories are skipped quietly (or the sound is muted, for words).</p>
        <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2">
          <label htmlFor="filter-all" className="text-sm">Set every category to</label>
          <select id="filter-all" value="" onChange={(e) => e.target.value && setAllFilters(e.target.value)} className="h-8 w-48 max-w-[62%] shrink-0 rounded-md border border-input bg-transparent px-2 text-sm">
            <option value="" className="bg-popover">Choose…</option>
            {FILTER_STRENGTHS.map(([v, label]) => (
              <option key={v} value={v} className="bg-popover">{label}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          {FILTER_CATEGORIES.map((category) => (
            <div key={category} className="flex items-center justify-between gap-3">
              <label htmlFor={`filter-${category}`} className="min-w-0 flex-1 text-sm leading-tight">{CATEGORY_LABELS[category]}</label>
              <select
                id={`filter-${category}`}
                value={contentFilter[category] ?? "off"}
                onChange={(e) => {
                  const next = { ...contentFilter };
                  if (isFilterSeverity(e.target.value)) next[category] = e.target.value;
                  else delete next[category];
                  setContentFilter(next);
                }}
                className="h-8 w-48 max-w-[62%] shrink-0 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {FILTER_STRENGTHS.map(([v, label]) => (
                  <option key={v} value={v} className="bg-popover">{label}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </fieldset>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={save} className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <DialogHeader>
            <DialogTitle>{profile ? "Edit profile" : "Add profile"}</DialogTitle>
            <DialogDescription>Each profile keeps its own watch history and settings.</DialogDescription>
          </DialogHeader>

          {canExtend ? (
            <Tabs defaultValue="profile" className="min-w-0 gap-4">
              <TabsList className="w-full">
                <TabsTrigger value="profile">Profile</TabsTrigger>
                <TabsTrigger value="watching">Watching</TabsTrigger>
                <TabsTrigger value="skipping">Skipping{filtered + autoSkipCount > 0 ? ` (${filtered + autoSkipCount})` : ""}</TabsTrigger>
              </TabsList>
              <TabsContent value="profile" className="min-h-[22rem]">{profileFields}</TabsContent>
              <TabsContent value="watching" className="min-h-[22rem]">{watching}</TabsContent>
              <TabsContent value="skipping" className="min-h-[22rem]">{skipping}</TabsContent>
            </Tabs>
          ) : (
            profileFields
          )}

          {canExtend && actor.hasPin && profile && (
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

          <DialogFooter className="gap-2 sm:justify-between">
            {profile && canDelete ? (
              <Button type="button" variant="ghost" className="text-destructive" onClick={remove} disabled={busy}>
                Delete profile
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={busy || !name.trim() || (canExtend && actor.hasPin && !!profile && currentPin.length !== 4)}>
              {profile ? "Save" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
