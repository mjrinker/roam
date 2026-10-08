import { requireProfile } from "@/lib/auth/guards";
import { accountLabel } from "@/lib/auth/guests";
import { db } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { findOpenPairing, normalizeUserCode } from "@/lib/tv/pairing";
import { AuthShell } from "@/components/auth/auth-shell";
import { LinkTvForm } from "@/components/tv/link-tv-form";

/** Where a person types the code their TV is showing, to sign that TV in. Scanning the TV's QR code arrives here with the code filled in. */
export default async function LinkPage({ searchParams }: PageProps<"/link">) {
  const account = await requireProfile();
  if (account.isGuest) {
    return (
      <AuthShell title="Sign in a TV" description="Guests can't sign in a TV, because a TV signs in with an account. Create an account first, then come back here.">
        {null}
      </AuthShell>
    );
  }

  // A code in the address (from the QR code) skips straight to "is this your TV?", counted against the same try limit as typing one in.
  const raw = (await searchParams).code;
  const code = normalizeUserCode(typeof raw === "string" ? raw : null);
  const open = code && (await checkRateLimit(account.id, "tv_pair", 20, 10 * 60)) ? await findOpenPairing(db, code) : null;
  return (
    <AuthShell title="Sign in a TV" description="Type the code your TV is showing to sign it in to your account.">
      <LinkTvForm email={accountLabel(account)} initial={open && code ? { code, deviceLabel: open.deviceLabel, location: open.locationHint } : undefined} />
    </AuthShell>
  );
}
