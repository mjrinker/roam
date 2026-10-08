import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { GuestButton } from "@/components/auth/guest-button";
import { getJoinTarget } from "@/lib/auth/join";

// The address of this page is the key to the server: it must never go out in a Referer header from any link on it.
export const metadata = { referrer: "no-referrer" as const, robots: { index: false, follow: false } };

export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;
  const target = await getJoinTarget(token);

  // Unknown, switched off, replaced and malformed links all look the same, and say nothing about any server.
  if (!target) {
    return (
      <AuthShell title="This link isn't valid" description="It may have been switched off or replaced. Ask whoever shared it for a new one.">
        <a href="/sign-in" className="flex h-11 items-center justify-center rounded-xl bg-white/[0.06] text-sm font-medium ring-1 ring-white/10 transition-colors hover:bg-white/10">
          Go to sign in
        </a>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={
        <>
          Join <span className="text-primary">{target.serverName}</span>
        </>
      }
      description={
        target.isDemo ? (
          <>
            A public demo of Roam. The movies and shows are <strong>placeholder footage</strong> (public-domain or openly licensed clips)
            under familiar names; nothing here is the real film.
          </>
        ) : (
          "You've been invited to join this server."
        )
      }
    >
      {target.isDemo ? (
        <div className="flex flex-col gap-5">
          <GuestButton joinToken={token} />
          <p className="text-center text-xs text-muted-foreground">
            No email or password. Your guest pass is deleted after about a week of not visiting, and other visitors can&apos;t see you.
          </p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-white/10" />
            or sign in to keep your own account
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <AuthForm mode="sign-in" joinToken={token} />
        </div>
      ) : (
        <AuthForm mode="sign-in" joinToken={token} />
      )}
    </AuthShell>
  );
}
