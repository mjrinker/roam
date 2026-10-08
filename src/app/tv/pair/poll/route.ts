import { cookies } from "next/headers";
import { db } from "@/lib/db/client";
import { pollPairing } from "@/lib/tv/pairing";
import { mintTvSession } from "@/lib/tv/session";
import { json, TV_PAIR_COOKIE } from "@/lib/tv/http";

/** The TV asks whether its code has been approved. When it has, this request is the one that signs the TV in (the session cookies are set on this response). */
export async function POST() {
  const store = await cookies();
  const secret = store.get(TV_PAIR_COOKIE)?.value;
  if (!secret) return json({ status: "expired" });

  const result = await pollPairing(db, secret);
  if (result.status !== "approved") return json({ status: result.status });

  const minted = await mintTvSession(result.accountId);
  store.delete({ name: TV_PAIR_COOKIE, path: "/tv" });
  return json({ status: minted.ok ? "approved" : "expired" });
}
