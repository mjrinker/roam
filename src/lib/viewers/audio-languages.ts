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

/** Two-letter codes (what OpenSubtitles and web pages use) and their three-letter ones. */
const TWO_TO_THREE: Record<string, string> = { en: "eng", es: "spa", fr: "fra", de: "deu", it: "ita", pt: "por", nl: "nld", sv: "swe", da: "dan", no: "nor", fi: "fin", pl: "pol", cs: "ces", hu: "hun", ro: "ron", el: "ell", tr: "tur", ru: "rus", uk: "ukr", he: "heb", ar: "ara", fa: "fas", hi: "hin", ja: "jpn", ko: "kor", zh: "zho", th: "tha", vi: "vie", id: "ind" };

/** A language as any of its spellings ("en", "pt-BR", "eng", "fre") in the three-letter one; null when it isn't recognised. */
export function languageCode3(raw: string | null | undefined): string | null {
  const c = (raw ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return normalizeLanguage(c) ?? TWO_TO_THREE[c] ?? null;
}

/** A language's name for a label ("spa" is "Spanish"); the code in capitals when it isn't one of the listed languages. */
export function languageLabel(code3: string): string {
  return MEDIA_LANGUAGES.find((l) => l.code === code3)?.label ?? code3.toUpperCase();
}
