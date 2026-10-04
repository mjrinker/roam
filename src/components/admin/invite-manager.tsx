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
        {invites.map((invite) => (
          <Card key={invite.id}>
            <CardContent className="flex items-center justify-between py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm">{invite.email}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {invite.acceptedAt
                  ? `Accepted ${new Date(invite.acceptedAt).toLocaleDateString()}`
                  : `Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
