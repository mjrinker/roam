import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

import { signStreamToken, streamUrl, verifyStreamToken } from "./stream-token";

describe("stream tokens", () => {
  it("name one file on one connection until they expire", () => {
    const { token, expiresAt } = signStreamToken("conn-1", "file/with:odd chars?", 1_000);
    expect(verifyStreamToken(token, 2_000)).toEqual({ connectionId: "conn-1", fileId: "file/with:odd chars?" });
    expect(expiresAt.getTime()).toBe(1_000 + 4 * 3600_000);
    expect(verifyStreamToken(token, expiresAt.getTime() + 1)).toBeNull();
  });
  it("refuse anything altered or invented", () => {
    const { token } = signStreamToken("conn-1", "f", 1_000);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ c: "conn-1", f: "other", e: 9e15 })).toString("base64url");
    for (const bad of ["", "x", "a.b.c", `${forged}.${sig}`, `${payload}.${sig}x`, `${payload}.`, ".sig"]) expect(verifyStreamToken(bad, 2_000), bad).toBeNull();
  });
  it("make an address on the configured site, or a relative one", () => {
    expect(streamUrl("T", "https://roam.example.com/")).toBe("https://roam.example.com/api/storage/stream/T");
    expect(streamUrl("T", undefined)).toBe("/api/storage/stream/T");
  });
});
