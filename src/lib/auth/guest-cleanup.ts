import { after } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { deleteInactiveGuests } from "@/lib/auth/guests";

/**
 * After the response has gone out, removes a few inactive guests (see deleteInactiveGuests). There is no
 * scheduled job on this plan, so the demo tidies itself whenever someone joins. Never delays or fails the join.
 */
export function scheduleGuestCleanup(): void {
  after(async () => {
    try {
      const admin = createSupabaseServiceRoleClient();
      await deleteInactiveGuests(async (id) => {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error && !/not.?found/i.test(error.message)) throw error;
      });
    } catch (err) {
      console.error("Guest cleanup failed:", err);
    }
  });
}
