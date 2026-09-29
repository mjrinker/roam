/**
 * Whether a viewer's browser should be handed a row's browser-friendly
 * (remuxed) copy instead of the original — see lib/remux/. Pure, so it's
 * unit-testable without a database.
 */

/** A remuxed copy's duration may differ from the original's by container/priming rounding, never by much more. */
export const VARIANT_DURATION_TOLERANCE_SECONDS = 2;

export interface PrimaryForVariant {
  audioCodec: string | null;
  durationSeconds: number | null;
  durationMs: number | null;
  trimStartSeconds: number | null;
  trimDurationSeconds: number | null;
}

export interface VariantCandidate {
  boxFileId: string;
  durationSeconds: number | null;
  durationMs: number | null;
}

const seconds = (r: { durationSeconds: number | null; durationMs: number | null }) =>
  r.durationMs != null ? r.durationMs / 1000 : r.durationSeconds;

/**
 * True only when the original's audio is one this browser can't decode AND
 * the copy is probed, the same length, and long enough to cover the row's
 * trim window. Anything doubtful falls back to the original — a working
 * (if silent) file beats a truncated or mismatched one.
 */
export function shouldUseVariant(
  primary: PrimaryForVariant,
  variant: VariantCandidate,
  unsupportedCodecs: readonly string[]
): boolean {
  if (!primary.audioCodec || !unsupportedCodecs.includes(primary.audioCodec.toLowerCase())) return false;

  const primaryLen = seconds(primary);
  const variantLen = seconds(variant);
  if (primaryLen == null || variantLen == null) return false;
  if (Math.abs(primaryLen - variantLen) > VARIANT_DURATION_TOLERANCE_SECONDS) return false;

  if (primary.trimDurationSeconds != null) {
    const windowEnd = (primary.trimStartSeconds ?? 0) + primary.trimDurationSeconds;
    if (windowEnd > variantLen + 0.05) return false;
  }
  return true;
}

/** Parses the player's `?unsupportedCodecs=ac-3,ec-3` param: lowercase, deduped, only sane fourcc-ish tokens. */
export function parseUnsupportedCodecs(raw: string | null): string[] {
  if (!raw) return [];
  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9-]{3,8}$/.test(t));
  return [...new Set(tokens)];
}
