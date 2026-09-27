import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth/guards";
import { resolveLandingPath } from "@/lib/auth/servers";

export default async function Home() {
  const { account } = await requireViewer();
  redirect(await resolveLandingPath(account.id));
}
