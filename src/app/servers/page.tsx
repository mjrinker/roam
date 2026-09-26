import Link from "next/link";
import { requireProfile } from "@/lib/auth/guards";
import { listServerMemberships } from "@/lib/auth/servers";
import { CreateServerForm } from "@/components/servers/create-server-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SignOutButton } from "@/components/nav/sign-out-button";

const INVITE_ERROR_MESSAGES: Record<string, string> = {
  "invite-not-found": "That invite link is invalid or has expired.",
  "invite-email-mismatch": "That invite was sent to a different email address.",
};

export default async function ServersPage({
  searchParams,
}: PageProps<"/servers">) {
  const profile = await requireProfile();
  const params = await searchParams;
  const errorParam = typeof params.error === "string" ? params.error : null;

  const memberships = await listServerMemberships(profile.id);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your servers</h1>
          <p className="mt-1 text-sm text-muted-foreground">{profile.email}</p>
        </div>
        <SignOutButton />
      </div>

      {errorParam && (
        <p className="text-sm text-destructive">
          {INVITE_ERROR_MESSAGES[errorParam] ?? "Something went wrong."}
        </p>
      )}

      {memberships.length > 0 && (
        <div className="flex flex-col gap-3">
          {memberships.map((m) => (
            <Link key={m.serverId} href={`/s/${m.serverId}/library`}>
              <Card className="transition-colors hover:bg-muted">
                <CardContent className="flex items-center justify-between py-4">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{m.serverName}</p>
                    <Badge variant="secondary">{m.role}</Badge>
                    {m.boxAuthStatus === "needs_reauth" && (
                      <Badge variant="destructive">Box needs reconnecting</Badge>
                    )}
                    {m.boxAuthStatus === "disconnected" && (
                      <Badge variant="outline">Box not connected</Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <CreateServerForm />

      {memberships.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">
          You&apos;re not on any servers yet. Create one above, or ask whoever
          invited you to send a link.
        </p>
      )}
    </div>
  );
}
