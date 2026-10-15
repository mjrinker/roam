/** The pieces of the Kodi add-on that depend on the version and on where Roam is (scripts/package-kodi.ts writes them into the zip). */
import { siteOrigin } from "@/lib/tv/origin";

export { siteOrigin };

export const ADDON_ID = "plugin.video.roam";

/** `major.minor.build` as Kodi wants for an add-on version. */
export function validVersion(v: string): boolean {
  return /^\d{1,4}\.\d{1,4}\.\d{1,5}$/.test(v);
}

/** addon.xml with this version. */
export function addonXmlFor(template: string, version: string): string {
  if (!validVersion(version)) throw new Error("A version such as 1.0.0 is required.");
  const next = template.replace(/(<addon\b[^>]*\bversion=")[^"]*(")/, `$1${version}$2`);
  if (next === template && !template.includes(`version="${version}"`)) throw new Error("addon.xml has no version to set.");
  return next;
}

/** settings.xml with the site's address as the server address people start with. */
export function settingsXmlFor(template: string, origin: string): string {
  if (siteOrigin(origin) !== origin) throw new Error("A site origin (https, no path) is required.");
  if (!template.includes("{{SERVER}}")) throw new Error("settings.xml has no place for the server address.");
  return template.replace("{{SERVER}}", origin);
}
