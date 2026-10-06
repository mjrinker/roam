/**
 * The word for a favorite, spelled the way the profile's locale spells it: "Favorite" for en-US (and for
 * anything unknown, the default), "Favourite" for the locales that use the British spelling.
 */
const BRITISH_SPELLING = new Set(["GB", "AU", "NZ", "IE", "ZA", "IN", "CA", "SG", "HK", "MY", "NG", "KE"]);

export function favoriteWord(locale: string | null | undefined): "Favorite" | "Favourite" {
  const m = /^en[-_]([a-z]{2})\b/i.exec((locale ?? "").trim());
  return m && BRITISH_SPELLING.has(m[1].toUpperCase()) ? "Favourite" : "Favorite";
}

/** The words used around the feature, in the profile's spelling. */
export function favoriteWords(locale: string | null | undefined) {
  const word = favoriteWord(locale);
  const lower = word.toLowerCase();
  return {
    word,
    plural: `${word}s`,
    add: `Add to ${lower}s`,
    remove: `Remove from ${lower}s`,
    empty: `No ${lower}s yet`,
    emptyHint: `Tap the heart on a photo or video to add it to your ${lower}s.`,
  };
}
