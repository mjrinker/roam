import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invites, servers } from "@/lib/db/schema";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export default async function InvitePage({
  params,
}: PageProps<"/invite/[token]">) {
  const { token } = await params;

  const [invite] = await db
    .select({ email: invites.email, serverName: servers.name })
    .from(invites)
    .innerJoin(servers, eq(invites.serverId, servers.id))
    .where(
      and(
        eq(invites.token, token),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!invite) {
    return (
      <AuthShell
        title="Invite not found"
        description="This invite link is invalid, expired, or has already been used. Ask whoever invited you to send a new one."
      >
        <a
          href="/sign-in"
          className="flex h-11 items-center justify-center rounded-xl bg-white/[0.06] text-sm font-medium ring-1 ring-white/10 transition-colors hover:bg-white/10"
        >
          Go to sign in
        </a>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={
        <>
          You&apos;re invited to <span className="text-primary">{invite.serverName}</span>
        </>
      }
      description={
        <>
          Finish setting up <span className="font-medium text-foreground">{invite.email}</span>{" "}
          to get started.
        </>
      }
    >
      <AuthForm mode="invite" initialEmail={invite.email} inviteToken={token} />
    </AuthShell>
  );
}
