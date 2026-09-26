import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth/guards";
import { resolveLandingPath } from "@/lib/auth/servers";

export default async function Home() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/sign-in");
  redirect(await resolveLandingPath(profile.id));
}
