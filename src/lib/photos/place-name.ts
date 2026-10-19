/**
 * A short place name ("Lake Tahoe, California") from what OpenStreetMap's Nominatim answers for a position. Pure, so the choice of words is tested.
 */
export interface NominatimAddress {
  [key: string]: string | undefined;
}

const LOCALITY = ["city", "town", "village", "hamlet", "suburb", "neighbourhood", "municipality", "county"];

export function placeNameFrom(result: { display_name?: string; address?: NominatimAddress } | null | undefined): string | null {
  if (!result) return null;
  const a = result.address ?? {};
  // A named place worth naming (a park, a lake, a landmark) comes first when Nominatim gives one.
  const feature = a.tourism ?? a.leisure ?? a.natural ?? a.historic ?? a.amenity ?? null;
  const locality = LOCALITY.map((k) => a[k]).find((v) => !!v) ?? null;
  const parts = [feature, locality, a.state ?? a.region ?? null, a.country_code && a.country_code.toLowerCase() !== "us" ? a.country : null].filter((v): v is string => !!v);
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  if (unique.length > 0) return unique.join(", ").slice(0, 200);
  const fallback = (result.display_name ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3).join(", ");
  return fallback || null;
}
