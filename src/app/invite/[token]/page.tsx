import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invites, servers } from "@/lib/db/schema";
import { AuthForm } from "@/components/auth/auth-form";

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
      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Invite not found</h1>
        <p className="text-sm text-muted-foreground">
          This invite link is invalid, expired, or has already been used. Ask
          whoever invited you to send a new one.
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          You&apos;re invited to {invite.serverName}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Finish setting up <span className="font-medium">{invite.email}</span>{" "}
          to get started.
        </p>
      </div>
      <AuthForm mode="invite" initialEmail={invite.email} inviteToken={token} />
    </main>
  );
}
