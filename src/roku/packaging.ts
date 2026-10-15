/** The pieces of the Roku channel that depend on where Roam is and which version this is (scripts/package-roku.ts writes them into the package). */
import { siteOrigin } from "@/lib/tv/origin";

export { siteOrigin };

/** `major.minor.build`, each a whole number, as a Roku manifest wants. */
export function parseVersion(v: string): { major: number; minor: number; build: number } {
  const m = /^(\d{1,4})\.(\d{1,4})(?:\.(\d{1,5}))?$/.exec(v.trim());
  if (!m) throw new Error("A version such as 1.0.0 is required.");
  return { major: Number(m[1]), minor: Number(m[2]), build: Number(m[3] ?? 0) };
}

/** roku/source/config.brs for a site: its address, and the audio formats a Roku can't play. */
export function configBrs(origin: string): string {
  if (siteOrigin(origin) !== origin) throw new Error("A site origin (https, no path) is required.");
  const quoted = origin.replace(/"/g, '""');
  return `' The address of the Roam this channel talks to. scripts/package-roku.ts writes this file for your site.
function roamBaseUrl() as String
  return "${quoted}"
end function

' Roku plays Dolby Digital natively, so only the formats it can't play are listed (the server then offers a fixed copy where it has one).
function roamUnsupportedAudio() as String
  return "dtsc,dtsh,dtsl,dtse,dtsx,dtsy,ac-4,mha1,mhm1,alac,lpcm,sowt,twos,ipcm"
end function

' The sound of a muted scene can't be switched off reliably on every Roku, so a profile that mutes a scene has it skipped instead.
function roamMuteAsSkip() as Boolean
  return true
end function
`;
}

/** The manifest with this version filled in (the rest of the file is kept as written in roku/manifest). */
export function manifestFor(template: string, version: string): string {
  const v = parseVersion(version);
  const set = (text: string, key: string, value: number) => (new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`);
  return set(set(set(template, "major_version", v.major), "minor_version", v.minor), "build_version", v.build);
}
