"use client";

import { useEffect, useState } from "react";
import { Crown, Globe, Loader2, Lock, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ViewerAvatar } from "@/components/profiles/viewer-avatar";
import { ConfirmDialog } from "@/components/playlists/confirm-dialog";
import { playlistApi, type MemberRow, type PickerViewer } from "@/components/playlists/playlist-api";
import {
  ROLE_INFO,
  canChangeRole,
  canRemoveShare,
  defaultRole,
  pickCandidates,
  type ShareCaps,
  type ShareRole,
} from "@/components/playlists/sharing";
import { cn } from "@/lib/utils";

const ROLE_ORDER: ShareRole[] = ["viewer", "sharer", "editor"];

function RoleSelect({
  value,
  roles,
  disabled,
  onChange,
  label,
}: {
  value: ShareRole;
  roles: readonly ShareRole[];
  disabled?: boolean;
  onChange: (role: ShareRole) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ShareRole)}
      title={ROLE_INFO[value].hint}
      className="h-8 cursor-pointer rounded-lg bg-white/[0.08] px-2 text-xs ring-1 ring-white/10 outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
    >
      {ROLE_ORDER.filter((r) => roles.includes(r) || r === value).map((r) => (
        <option key={r} value={r} className="bg-popover text-popover-foreground">
          {ROLE_INFO[r].label}
        </option>
      ))}
    </select>
  );
}

/** Who can see a playlist and what they can do: visibility, current shares, adding people, handing over ownership. */
export function ShareDialog({
  open,
  onOpenChange,
  serverId,
  playlistId,
  visibility,
  ownerId,
  caps,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  playlistId: string;
  visibility: "private" | "server";
  /** The owner's profile id, or null for an ownerless playlist. */
  ownerId: string | null;
  caps: ShareCaps;
  /** Called after any change, so the page can refresh. */
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerViewer[]>([]);
  const [pickerCursor, setPickerCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [newRole, setNewRole] = useState<ShareRole>(defaultRole(caps.grantRoles));
  const [busy, setBusy] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState<MemberRow | null>(null);
  const [vis, setVis] = useState(visibility);

  // The dialog mounts fresh each time it opens, so `loading` starts true and needs no reset here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [m, p] = await Promise.all([
        playlistApi.members(playlistId, null),
        caps.share ? playlistApi.picker(serverId, null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (!m.ok) setLoadError(m.error);
      else {
        setMembers(m.data.members);
        setMemberCursor(m.data.nextCursor);
      }
      if (p && p.ok) {
        setPicker(p.data.viewers);
        setPickerCursor(p.data.nextCursor);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [playlistId, serverId, caps.share]);

  async function moreMembers() {
    const res = await playlistApi.members(playlistId, memberCursor);
    if (!res.ok) return toast.error(res.error);
    setMembers((cur) => [...cur, ...res.data.members.filter((n) => !cur.some((c) => c.id === n.id))]);
    setMemberCursor(res.data.nextCursor);
  }

  async function morePicker() {
    const res = await playlistApi.picker(serverId, pickerCursor);
    if (!res.ok) return toast.error(res.error);
    setPicker((cur) => [...cur, ...res.data.viewers.filter((n) => !cur.some((c) => c.id === n.id))]);
    setPickerCursor(res.data.nextCursor);
  }

  async function changeVisibility(next: "private" | "server") {
    if (next === vis) return;
    setBusy("visibility");
    const res = await playlistApi.setVisibility(playlistId, next);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    setVis(next);
    toast.success(next === "server" ? "Everyone on this server can now see it." : "It's private again.");
    onChanged();
  }

  async function add(person: PickerViewer) {
    setBusy(person.id);
    const res = await playlistApi.share(playlistId, person.id, newRole);
    setBusy(null);
    if (!res.ok) {
      // The server answers every invalid target identically, so say so plainly.
      return toast.error(res.status === 404 ? "Couldn't share with that profile." : res.error);
    }
    setMembers((cur) => [...cur.filter((m) => m.id !== person.id), { ...person, role: newRole, isMe: false, grantedByMe: true }]);
    toast.success(`Shared with ${person.name}.`);
    onChanged();
  }

  async function changeRole(member: MemberRow, role: ShareRole) {
    setBusy(member.id);
    const res = await playlistApi.changeRole(playlistId, member.id, role);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    setMembers((cur) => cur.map((m) => (m.id === member.id ? { ...m, role } : m)));
    onChanged();
  }

  async function remove(member: MemberRow) {
    setBusy(member.id);
    const res = await playlistApi.removeMember(playlistId, member.id);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    setMembers((cur) => cur.filter((m) => m.id !== member.id));
    onChanged();
  }

  const sharedIds = new Set(members.map((m) => m.id));
  const candidates = pickCandidates(picker, sharedIds, ownerId, query);
  const canAnyVisibility = caps.makePublic || caps.makePrivate;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Share playlist</DialogTitle>
            <DialogDescription>Choose who can see this playlist and what they can do with it.</DialogDescription>
          </DialogHeader>

          {canAnyVisibility && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Who can see it</h3>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { value: "private", label: "Only people I choose", icon: Lock, allowed: caps.makePrivate || vis === "private" },
                    { value: "server", label: "Everyone on this server", icon: Globe, allowed: caps.makePublic || vis === "server" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    disabled={!o.allowed || busy === "visibility"}
                    onClick={() => void changeVisibility(o.value)}
                    aria-pressed={vis === o.value}
                    className={cn(
                      "flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm ring-1 transition disabled:opacity-50",
                      vis === o.value ? "bg-primary/15 text-primary ring-primary/40" : "bg-white/[0.05] ring-white/10 hover:bg-white/[0.08]"
                    )}
                  >
                    <o.icon className="size-4 shrink-0" />
                    {o.label}
                  </button>
                ))}
              </div>
              {vis === "server" && (
                <p className="text-xs text-muted-foreground">Everyone on this server can watch and copy it, but only the people below can change it.</p>
              )}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">People with access</h3>
            {loading && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </p>
            )}
            {loadError && <p className="text-sm text-destructive">{loadError}</p>}
            {!loading && !loadError && members.length === 0 && (
              <p className="text-sm text-muted-foreground">Not shared with anyone yet.</p>
            )}
            <ul className="flex flex-col gap-1">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-2.5 rounded-lg p-1.5">
                  <ViewerAvatar avatarKey={m.avatarKey} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {m.name}
                    {m.isMe && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                  </span>
                  {canChangeRole(caps, m) ? (
                    <RoleSelect label={`Role for ${m.name}`} value={m.role} roles={caps.grantRoles} disabled={busy === m.id} onChange={(r) => void changeRole(m, r)} />
                  ) : (
                    <span className="text-xs text-muted-foreground">{ROLE_INFO[m.role].label}</span>
                  )}
                  {caps.manageMembers && !m.isMe && (
                    <button
                      type="button"
                      aria-label={`Make ${m.name} the owner`}
                      title="Make owner"
                      disabled={busy !== null}
                      onClick={() => setTransferTo(m)}
                      className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-primary disabled:opacity-40"
                    >
                      <Crown className="size-4" />
                    </button>
                  )}
                  {canRemoveShare(caps, m) && (
                    <button
                      type="button"
                      aria-label={`Stop sharing with ${m.name}`}
                      disabled={busy !== null}
                      onClick={() => void remove(m)}
                      className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-destructive disabled:opacity-40"
                    >
                      <X className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {memberCursor && (
              <Button variant="ghost" size="sm" onClick={() => void moreMembers()}>
                Show more
              </Button>
            )}
          </section>

          {caps.share && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Add people</h3>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  They can
                  <RoleSelect label="Role for new shares" value={newRole} roles={caps.grantRoles} onChange={setNewRole} />
                </label>
              </div>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search profiles" aria-label="Search profiles" />
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                {candidates.map((p) => (
                  <li key={p.id} className="flex items-center gap-2.5 rounded-lg p-1.5">
                    <ViewerAvatar avatarKey={p.avatarKey} size="xs" />
                    <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                    <Button size="sm" variant="secondary" className="gap-1.5" disabled={busy !== null} onClick={() => void add(p)}>
                      {busy === p.id ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />} Add
                    </Button>
                  </li>
                ))}
                {!loading && candidates.length === 0 && (
                  <li className="p-1.5 text-sm text-muted-foreground">
                    {picker.length === 0 ? "No other profiles on this server are available to share with." : "No matching profiles."}
                  </li>
                )}
              </ul>
              {pickerCursor && (
                <Button variant="ghost" size="sm" onClick={() => void morePicker()}>
                  Show more profiles
                </Button>
              )}
            </section>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={transferTo !== null}
        onOpenChange={(o) => !o && setTransferTo(null)}
        title={transferTo ? `Make ${transferTo.name} the owner?` : "Make owner"}
        description="They'll be able to delete it and change who it's shared with. You'll stay on as an editor."
        confirmLabel="Make owner"
        onConfirm={async () => {
          if (!transferTo) return null;
          const res = await playlistApi.transfer(playlistId, transferTo.id);
          if (!res.ok) return res.status === 404 ? "That profile can't take ownership." : res.error;
          toast.success(`${transferTo.name} is now the owner.`);
          onOpenChange(false);
          onChanged();
          return null;
        }}
      />
    </>
  );
}
