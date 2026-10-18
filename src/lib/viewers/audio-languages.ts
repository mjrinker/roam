/** The languages a profile can ask for by default: audio, and subtitles. Codes are ISO 639-2/T as video files write them ("eng"). */
export const MEDIA_LANGUAGES: { code: string; label: string }[] = [
  { code: "eng", label: "English" },
  { code: "spa", label: "Spanish" },
  { code: "fra", label: "French" },
  { code: "por", label: "Portuguese" },
  { code: "deu", label: "German" },
  { code: "ita", label: "Italian" },
  { code: "nld", label: "Dutch" },
  { code: "swe", label: "Swedish" },
  { code: "pol", label: "Polish" },
  { code: "rus", label: "Russian" },
  { code: "tur", label: "Turkish" },
  { code: "ara", label: "Arabic" },
  { code: "heb", label: "Hebrew" },
  { code: "hin", label: "Hindi" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
  { code: "zho", label: "Chinese" },
];

/** Files also use the older bibliographic codes (fre, ger, chi, dut): they mean the same language. */
const ALIASES: Record<string, string> = { fre: "fra", ger: "deu", chi: "zho", dut: "nld", cze: "ces", gre: "ell", per: "fas", rum: "ron", slo: "slk", wel: "cym", alb: "sqi", arm: "hye", baq: "eus", geo: "kat", ice: "isl", mac: "mkd", mao: "mri", may: "msa", bur: "mya", tib: "bod" };

/** A language code as a file or a form gave it, in its one standard spelling; null when it isn't a three-letter code. */
export function normalizeLanguage(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(c)) return null;
  return ALIASES[c] ?? c;
}

export const sameLanguage = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = normalizeLanguage(a);
  return x !== null && x === normalizeLanguage(b);
};
