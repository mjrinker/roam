import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { deviceTokens } from "@/lib/db/schema";
import { createDeviceToken } from "@/lib/auth/device-token";
import { createTestDb, makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { accessToken, resetAccessToken, sendFcmTo, serviceAccount, setPushToken, signAssertion } from "./fcm";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetAccessToken();
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const sa = { project_id: "roam-test", client_email: "push@roam-test.iam.gserviceaccount.com", private_key: privateKey };

describe("the service account", () => {
  it("is read from the environment, and is null when absent or unusable", () => {
    expect(serviceAccount({})).toBeNull();
    expect(serviceAccount({ FCM_SERVICE_ACCOUNT: "not json" })).toBeNull();
    expect(serviceAccount({ FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: "p" }) })).toBeNull();
    expect(serviceAccount({ FCM_SERVICE_ACCOUNT: JSON.stringify(sa) })?.project_id).toBe("roam-test");
  });
});

describe("the signed request for an access token", () => {
  it("names who asks, what for, and for how long, and is signed with the account's key", () => {
    const jwt = signAssertion(sa, 1_000);
    const [head, claims, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: 1_000, exp: 4_600,
    });
    expect(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(createPublicKey(publicKey), Buffer.from(sig, "base64url"))).toBe(true);
  });
  it("is exchanged once and kept until close to running out", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }), { status: 200 }));
    expect(await accessToken(sa, fetchImpl as never, 0)).toBe("ya29.x");
    expect(await accessToken(sa, fetchImpl as never, 1000)).toBe("ya29.x");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await accessToken(sa, fetchImpl as never, 3_600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("is null when Google refuses", async () => {
    expect(await accessToken(sa, (async () => new Response("no", { status: 401 })) as never)).toBeNull();
  });
});

describe("sending to an account's apps", () => {
  const fakeFetch = (messageStatus = 200, errorStatus?: string) => {
    const sent: { url: string; headers: Record<string, string>; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const impl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.t", expires_in: 3600 }), { status: 200 });
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return new Response(errorStatus ? JSON.stringify({ error: { status: errorStatus } }) : "{}", { status: messageStatus });
    });
    return { impl: impl as unknown as typeof fetch, sent };
  };
  const device = async (who: Awaited<ReturnType<typeof makeAccount>>, token: string | null, label = "Phone") => {
    const { row } = await createDeviceToken(db, { accountId: who.accountId, label });
    if (token) await setPushToken(db, row.id, token);
    return row;
  };
  const tokenOf = async (id: string) => (await db.select().from(deviceTokens).where(eq(deviceTokens.id, id)))[0].pushToken;

  it("does nothing when push to apps isn't set up", async () => {
    const who = await makeAccount(db, "nopush");
    await device(who, "tok-aaaaaaaaaaaaaaaaaaaa");
    const f = fakeFetch();
    await sendFcmTo(db, who.accountId, { title: "Roam", body: "x", href: null }, f.impl);
    expect(f.impl).not.toHaveBeenCalled();
  });

  it("sends to each app that allowed it, with the words and where they lead, and not to others", async () => {
    vi.stubEnv("FCM_SERVICE_ACCOUNT", JSON.stringify(sa));
    const who = await makeAccount(db, "pushme");
    const other = await makeAccount(db, "someone-else");
    await device(who, "tok-phone-aaaaaaaaaaaaaaaa");
    await device(who, null, "No push");
    const revoked = await device(who, "tok-revoked-aaaaaaaaaaaaaa", "Old");
    await db.update(deviceTokens).set({ revokedAt: new Date() }).where(eq(deviceTokens.id, revoked.id));
    await device(other, "tok-other-aaaaaaaaaaaaaaaa");
    const f = fakeFetch();
    await sendFcmTo(db, who.accountId, { title: "Roam", body: "It's free now", href: "/s/1/title/2" }, f.impl);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].url).toBe("https://fcm.googleapis.com/v1/projects/roam-test/messages:send");
    expect(f.sent[0].headers.authorization).toBe("Bearer ya29.t");
    expect(f.sent[0].body.message).toMatchObject({ token: "tok-phone-aaaaaaaaaaaaaaaa", notification: { title: "Roam", body: "It's free now" }, data: { href: "/s/1/title/2" } });
  });

  it("forgets an app that has been uninstalled, and keeps one that merely failed", async () => {
    vi.stubEnv("FCM_SERVICE_ACCOUNT", JSON.stringify(sa));
    const who = await makeAccount(db, "gone");
    const a = await device(who, "tok-gone-aaaaaaaaaaaaaaaaaa");
    await sendFcmTo(db, who.accountId, { title: "Roam", body: "x", href: null }, fakeFetch(404, "NOT_FOUND").impl);
    expect(await tokenOf(a.id)).toBeNull();
    const b = await device(who, "tok-flaky-aaaaaaaaaaaaaaaaa");
    await sendFcmTo(db, who.accountId, { title: "Roam", body: "x", href: null }, fakeFetch(500).impl);
    expect(await tokenOf(b.id)).toBe("tok-flaky-aaaaaaaaaaaaaaaaa");
    const c = await device(who, "tok-bad-aaaaaaaaaaaaaaaaaaaa");
    await sendFcmTo(db, who.accountId, { title: "Roam", body: "x", href: null }, fakeFetch(400, "INVALID_ARGUMENT").impl);
    expect(await tokenOf(c.id)).toBeNull();
  });

  it("never throws when the network is down", async () => {
    vi.stubEnv("FCM_SERVICE_ACCOUNT", JSON.stringify(sa));
    const who = await makeAccount(db, "offline");
    await device(who, "tok-offline-aaaaaaaaaaaaaaa");
    await expect(sendFcmTo(db, who.accountId, { title: "Roam", body: "x", href: null }, (async () => { throw new Error("down"); }) as never)).resolves.toBeUndefined();
  });
});
