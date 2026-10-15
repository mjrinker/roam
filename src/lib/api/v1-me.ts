import type { Viewer } from "@/lib/db/schema";

/** What an app needs to show a profile in "Who's watching?": never the PIN or its hash. */
export function profileSummary(v: Pick<Viewer, "id" | "name" | "avatarKey" | "role" | "pinHash">, currentId: string | null) {
  return { id: v.id, name: v.name, avatarKey: v.avatarKey, role: v.role, hasPin: !!v.pinHash, selected: v.id === currentId };
}
