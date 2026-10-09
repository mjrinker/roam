/**
 * Resolution versions of one movie or episode ("Movie - 1080p.mp4", "Movie - 4K.mp4"): which one plays, what to call each, and how to
 * pick when the viewer has a preference. Pure (no database), so it can be tested on its own.
 */
import { labelHeightHint, resolutionName } from "@/lib/scan/conventions";

export interface VersionRowLike {
  versionLabel: string;
  width: number | null;
  height: number | null;
}

export interface VersionInfo {
  /** The version's key in the database ("" for files without a resolution label). */
  label: string;
  /** What the picker shows: "4K", "1080p", with the label's extra words when two versions would otherwise look alike. */
  name: string;
  /** A pixel height to compare versions by (probed when known, else guessed from the label); null when nothing is known. */
  height: number | null;
}

/** How tall a picture is for comparing versions: the larger of its height and what its width implies for 16:9 (cropped widescreen). */
export function effectiveHeight(width: number | null, height: number | null): number | null {
  if (!width && !height) return null;
  return Math.max(height ?? 0, Math.round(((width ?? 0) * 9) / 16));
}

export function groupRowsByVersion<T extends VersionRowLike>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.versionLabel) ?? [];
    list.push(row);
    groups.set(row.versionLabel, list);
  }
  return groups;
}

/** Each version of an owner's rows, best first, named for the picker (names are made unique). */
export function describeVersions<T extends VersionRowLike>(rows: readonly T[]): VersionInfo[] {
  const infos = [...groupRowsByVersion(rows)].map(([label, group]) => {
    const probed = group.find((r) => r.width || r.height);
    const height = probed ? effectiveHeight(probed.width, probed.height) : labelHeightHint(label);
    const fromPicture = probed ? resolutionName(probed.width, probed.height) : null;
    const base = fromPicture ?? (label ? label.replace(/^(\d{3,4})p\b/, "$1p").replace(/^([248])k\b/, "$1K").toUpperCase().replace(/(\d)P\b/, "$1p") : "Original");
    return { label, base, height };
  });
  infos.sort((a, b) => (b.height ?? -1) - (a.height ?? -1) || a.label.localeCompare(b.label));
  const seen = new Map<string, number>();
  for (const i of infos) seen.set(i.base, (seen.get(i.base) ?? 0) + 1);
  return infos.map((i) => ({
    label: i.label,
    // Two versions of the same resolution (a "1080p BluRay" and a "1080p WEB") are told apart by the words in their labels.
    name: (seen.get(i.base) ?? 0) > 1 && i.label ? `${i.base} (${i.label.replace(/^\S+\s*/, "") || i.label})` : i.base,
    height: i.height,
  }));
}

/**
 * Which version to play. An explicit request that exists wins; otherwise the version closest in height to `preferredHeight` (ties go
 * to the lower one, which always plays); with no preference, the highest. Always a label that exists in `versions`.
 */
export function pickVersion(versions: readonly VersionInfo[], requested: string | null, preferredHeight: number | null): string {
  if (versions.length === 0) return "";
  if (requested !== null && versions.some((v) => v.label === requested)) return requested;
  if (preferredHeight !== null) {
    let best = versions[0];
    let bestGap = Infinity;
    for (const v of versions) {
      if (v.height === null) continue;
      const gap = Math.abs(v.height - preferredHeight);
      if (gap < bestGap || (gap === bestGap && v.height < (best.height ?? Infinity))) {
        best = v;
        bestGap = gap;
      }
    }
    if (bestGap !== Infinity) return best.label;
  }
  return versions[0].label; // describeVersions lists the best first
}

/** Only the rows of the version that would play by default: for pages that add up or list an owner's files without playing them. */
export function defaultVersionRows<T extends VersionRowLike>(rows: readonly T[]): T[] {
  if (rows.length === 0) return [];
  const label = pickVersion(describeVersions(rows), null, null);
  return rows.filter((r) => r.versionLabel === label);
}
