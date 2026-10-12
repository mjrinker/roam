"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

export interface InviteRow {
  id: string;
  email: string;
  acceptedAt: string | null;
  expiresAt: string;
}

export function InviteManager({
  serverId,
  invites,
}: {
  serverId: string;
  invites: InviteRow[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [isPending, startTransition] = useTransition();
  // When the page was drawn: what counts as expired is judged against this.
  const [now] = useState(() => Date.now());

  async function remove(invite: InviteRow) {
    const pending = !invite.acceptedAt && new Date(invite.expiresAt).getTime() > now;
    const question = pending
      ? `Delete the invitation for ${invite.email}? Its link will stop working.`
      : `Delete the invitation for ${invite.email}? This only removes it from the list.`;
    if (!window.confirm(question)) return;
    const res = await fetch(`/api/invites/${invite.id}`, { method: "DELETE" });
    if (!res.ok) return toast.error("Couldn't delete that invitation.");
    toast.success("Invitation deleted.");
    startTransition(() => router.refresh());
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(typeof body.error === "string" ? body.error : "Couldn't create invite.");
      return;
    }
    const { inviteUrl } = await res.json();
    await navigator.clipboard.writeText(inviteUrl).catch(() => {});
    toast.success("Invite link copied to clipboard.");
    setEmail("");
    startTransition(() => router.refresh());
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Invite family members</h2>

      <form onSubmit={sendInvite} className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="sibling@example.com"
            required
            className="w-64"
          />
        </div>
        <Button type="submit" disabled={isPending}>
          Send invite
        </Button>
      </form>

      <div className="flex flex-col gap-2">
        {invites.map((invite) => {
          const expired = !invite.acceptedAt && new Date(invite.expiresAt).getTime() < now;
          return (
            <Card key={invite.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3">
                <span className="min-w-0 flex-1 text-sm break-words">{invite.email}</span>
                <span className={`text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}>
                  {invite.acceptedAt
                    ? `Accepted ${new Date(invite.acceptedAt).toLocaleDateString()}`
                    : expired
                      ? `Expired ${new Date(invite.expiresAt).toLocaleDateString()}`
                      : `Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
                </span>
                <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={isPending} onClick={() => void remove(invite)}>
                  Delete
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
