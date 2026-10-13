import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import { requireViewer } from "@/lib/auth/guards";
import { resolveLandingPath } from "@/lib/auth/servers";
import { getCurrentViewer } from "@/lib/auth/viewer";

/**
 * Someone signed in goes straight on to their server. Anyone else sees what Roam is for (a public front page, so it can be read before
 * signing in), with a way in.
 */
export default async function Home() {
  if (await getCurrentViewer()) {
    const { account } = await requireViewer();
    redirect(await resolveLandingPath(account.id));
  }
  return <LandingPage />;
}
