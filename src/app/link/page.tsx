import { requireProfile } from "@/lib/auth/guards";
import { accountLabel } from "@/lib/auth/guests";
import { AuthShell } from "@/components/auth/auth-shell";
import { LinkTvForm } from "@/components/tv/link-tv-form";

/** Where a person types the code their TV is showing, to sign that TV in. */
export default async function LinkPage() {
  const account = await requireProfile();
  if (account.isGuest) {
    return (
      <AuthShell title="Sign in a TV" description="Guests can't sign in a TV, because a TV signs in with an account. Create an account first, then come back here." >
        {null}
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Sign in a TV" description="Type the code your TV is showing to sign it in to your account.">
      <LinkTvForm email={accountLabel(account)} />
    </AuthShell>
  );
}
