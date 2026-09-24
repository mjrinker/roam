import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth/guards";

export default async function Home() {
  const profile = await getCurrentProfile();
  redirect(profile ? "/library" : "/sign-in");
}
