/** Locales a profile can pick. The region part also selects the rating country (see lib/content). */
export const LOCALES = [
  { tag: "en-US", label: "English (United States)" },
  { tag: "en-GB", label: "English (United Kingdom)" },
  { tag: "en-CA", label: "English (Canada)" },
  { tag: "en-AU", label: "English (Australia)" },
  { tag: "fr-CA", label: "Français (Canada)" },
  { tag: "fr-FR", label: "Français (France)" },
  { tag: "de-DE", label: "Deutsch (Deutschland)" },
  { tag: "es-ES", label: "Español (España)" },
  { tag: "es-MX", label: "Español (México)" },
  { tag: "it-IT", label: "Italiano (Italia)" },
  { tag: "nl-NL", label: "Nederlands (Nederland)" },
  { tag: "pt-BR", label: "Português (Brasil)" },
] as const;

export const DEFAULT_LOCALE = "en-US";

const TAGS = new Set<string>(LOCALES.map((l) => l.tag));

export function isSupportedLocale(tag: string): boolean {
  return TAGS.has(tag);
}
