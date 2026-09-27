import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// A 4-digit PIN has only 10,000 possibilities, so the hash can't stand up to
// offline guessing; the real protection is rate limiting the select route.
// scrypt with a per-PIN salt still keeps equal PINs from looking equal and
// makes a leaked column costlier than a bare hash.

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

export function isValidPinFormat(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

/** `scrypt$N=16384$r=8$p=1$<salt b64>$<hash b64>` */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEY_LENGTH, { N, r: R, p: P });
  return `scrypt$N=${N}$r=${R}$p=${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nPart, rPart, pPart, saltB64, hashB64] = parts;
  const n = Number(nPart.slice(2));
  const r = Number(rPart.slice(2));
  const p = Number(pPart.slice(2));
  if (!n || !r || !p) return false;

  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(pin, Buffer.from(saltB64, "base64"), expected.length, { N: n, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
