/**
 * How to show a photo large. Pure, so the routes and tests share one rule.
 *
 * A small picture a browser can show itself is served as the original (nothing is lost and there is
 * no waiting for Box to render anything). A larger one gets Box's 2048px JPEG, falling back to the
 * original only while that is still a sensible size. HEIC and its kin can't be shown by most browsers,
 * so they are NEVER served as the original: Box's rendering, else the small thumbnail.
 */
const MIB = 1024 * 1024;
const BROWSER_NATIVE = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

/** Up to this size a browser-native picture is just served as it is. */
export const ORIGINAL_DIRECT_MAX_BYTES = 3 * MIB;
/** Up to this size the original is an acceptable stand-in when Box can't make a preview. */
export const ORIGINAL_FALLBACK_MAX_BYTES = 15 * MIB;

export interface PreviewPlan {
  /** Serve the original straight away, without asking Box for a rendering. */
  direct: boolean;
  /** If Box can't make a preview, serving the original is acceptable. */
  originalFallback: boolean;
}

export function planPreview(container: string | null, sizeBytes: number | null): PreviewPlan {
  const type = (container ?? "").toLowerCase();
  if (!BROWSER_NATIVE.has(type)) return { direct: false, originalFallback: false };
  const size = sizeBytes ?? Number.POSITIVE_INFINITY;
  // An animated GIF is only itself as the original, so it is served whole at any size we'd accept.
  if (type === "gif") return { direct: size <= ORIGINAL_FALLBACK_MAX_BYTES, originalFallback: size <= ORIGINAL_FALLBACK_MAX_BYTES };
  return { direct: size <= ORIGINAL_DIRECT_MAX_BYTES, originalFallback: size <= ORIGINAL_FALLBACK_MAX_BYTES };
}
