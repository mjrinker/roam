import { cookies } from "next/headers";
import { db } from "@/lib/db/client";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { formatUserCode, openCodeForSecret, PAIRING_TTL_MS, startPairing } from "@/lib/tv/pairing";
import { clientAddress, html, redirectTo, TV_PAIR_COOKIE } from "@/lib/tv/http";
import { messagePage, pairPage } from "@/tv/render";

/** The TV's sign-in screen: a short code to approve from a phone. Already signed in? On to the TV home. */
export async function GET(request: Request) {
  if (await getCurrentViewer()) return redirectTo(request, "/tv");

  const store = await cookies();
  const existing = store.get(TV_PAIR_COOKIE)?.value;
  let userCode = existing ? await openCodeForSecret(db, existing) : null;
  if (!userCode) {
    const started = await startPairing(db, { ip: clientAddress(request), userAgent: request.headers.get("user-agent") });
    if (!started.ok) return html(messagePage("Try again later", started.reason === "too_many" ? "This TV has asked for too many codes. Wait a little while and try again." : "Roam is busy right now. Try again in a minute."), 429);
    store.set(TV_PAIR_COOKIE, started.secret, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/tv", maxAge: Math.floor(PAIRING_TTL_MS / 1000) });
    userCode = started.userCode;
  }
  const host = new URL(request.url).host;
  return html(pairPage({ userCode: formatUserCode(userCode), linkUrl: `${host}/link`, pollUrl: "/tv/pair/poll", expiredUrl: "/tv/pair" }));
}
