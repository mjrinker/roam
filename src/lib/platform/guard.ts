import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/guards";
import { getCurrentViewer } from "@/lib/auth/viewer";

/** For a page: the signed-in account if it is a platform admin; anyone else gets "not found" (the page's existence isn't revealed). */
export async function requirePlatformAdmin() {
  const { account } = await requireViewer();
  if (!account.isPlatformAdmin) notFound();
  return account;
}

/** For an API route: the platform admin's account, or null. */
export async function getPlatformAdmin() {
  const resolved = await getCurrentViewer();
  return resolved?.account.isPlatformAdmin ? resolved.account : null;
}
