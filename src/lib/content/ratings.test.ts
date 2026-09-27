import { describe, expect, it } from "vitest";
import {
  ageForCertification,
  countryFromLocale,
  displayCertification,
  parseMovieCertifications,
  parseTvCertifications,
  ratingsForAudiobook,
  ratingsFromMovieDetails,
  ratingsFromTvDetails,
  type TmdbReleaseDatesResult,
} from "./ratings";

describe("ageForCertification", () => {
  it("covers the US movie and TV ladders", () => {
    expect(ageForCertification("US", "G")).toBe(0);
    expect(ageForCertification("US", "PG")).toBe(10);
    expect(ageForCertification("US", "PG-13")).toBe(13);
    expect(ageForCertification("US", "R")).toBe(17);
    expect(ageForCertification("US", "NC-17")).toBe(18);
    expect(ageForCertification("US", "TV-Y")).toBe(0);
    expect(ageForCertification("US", "TV-Y7")).toBe(7);
    expect(ageForCertification("US", "TV-PG")).toBe(10);
    expect(ageForCertification("US", "TV-14")).toBe(13);
    expect(ageForCertification("US", "TV-MA")).toBe(17);
  });

  it("covers GB, DE, FR, CA, AU, NL", () => {
    expect(ageForCertification("GB", "12A")).toBe(12);
    expect(ageForCertification("GB", "18")).toBe(18);
    expect(ageForCertification("DE", "0")).toBe(0);
    expect(ageForCertification("DE", "16")).toBe(16);
    expect(ageForCertification("FR", "TP")).toBe(0);
    expect(ageForCertification("CA", "14A")).toBe(14);
    expect(ageForCertification("AU", "MA15+")).toBe(15);
    expect(ageForCertification("NL", "AL")).toBe(0);
  });

  it("falls back to a bare number for an unlisted country", () => {
    expect(ageForCertification("BR", "16")).toBe(16);
    expect(ageForCertification("JP", "18+")).toBe(18);
  });

  it("returns null for something it can't parse", () => {
    expect(ageForCertification("US", "Approved")).toBeNull();
    expect(ageForCertification("XX", "banana")).toBeNull();
  });
});

function releaseDates(country: string, entries: { certification?: string; type: number }[]): TmdbReleaseDatesResult {
  return { iso_3166_1: country, release_dates: entries };
}

describe("parseMovieCertifications", () => {
  it("prefers theatrical over other release types", () => {
    const result = parseMovieCertifications([
      releaseDates("US", [
        { type: 4, certification: "PG-13" },
        { type: 3, certification: "R" },
      ]),
    ]);
    expect(result).toEqual({ US: "R" });
  });

  it("falls back through the type order when the preferred type has no certification", () => {
    const result = parseMovieCertifications([
      releaseDates("US", [
        { type: 3, certification: "" },
        { type: 2, certification: "PG-13" },
      ]),
    ]);
    expect(result).toEqual({ US: "PG-13" });
  });

  it("drops placeholder certifications like NR and empty strings", () => {
    const result = parseMovieCertifications([
      releaseDates("US", [{ type: 3, certification: "NR" }]),
      releaseDates("FR", [{ type: 3, certification: "" }]),
    ]);
    expect(result).toEqual({});
  });

  it("handles no results at all", () => {
    expect(parseMovieCertifications(undefined)).toEqual({});
    expect(parseMovieCertifications([])).toEqual({});
  });
});

describe("parseTvCertifications", () => {
  it("reads several countries and skips placeholders", () => {
    expect(
      parseTvCertifications([
        { iso_3166_1: "US", rating: "TV-14" },
        { iso_3166_1: "GB", rating: "" },
      ])
    ).toEqual({ US: "TV-14" });
  });
});

describe("ratingsFromMovieDetails", () => {
  it("combines certifications with the adult flag", () => {
    expect(
      ratingsFromMovieDetails({
        adult: true,
        release_dates: { results: [releaseDates("US", [{ type: 3, certification: "R" }])] },
      })
    ).toEqual({ certifications: { US: "R" }, ratingAges: { US: 17, ANY: 18 } });
  });

  it("omits ANY when not adult", () => {
    expect(
      ratingsFromMovieDetails({ release_dates: { results: [releaseDates("US", [{ type: 3, certification: "G" }])] } })
    ).toEqual({ certifications: { US: "G" }, ratingAges: { US: 0 } });
  });

  it("keeps an unrecognized certification for display but not in rating_ages", () => {
    const result = ratingsFromMovieDetails({
      release_dates: { results: [releaseDates("ZZ", [{ type: 3, certification: "Weird" }])] },
    });
    expect(result.certifications).toEqual({ ZZ: "WEIRD" });
    expect(result.ratingAges).toEqual({});
  });
});

describe("ratingsFromTvDetails", () => {
  it("parses content_ratings", () => {
    expect(ratingsFromTvDetails({ content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-MA" }] } })).toEqual({
      certifications: { US: "TV-MA" },
      ratingAges: { US: 17 },
    });
  });

  it("handles no content_ratings", () => {
    expect(ratingsFromTvDetails({})).toEqual({ certifications: {}, ratingAges: {} });
  });
});

describe("ratingsForAudiobook", () => {
  it("flags adult content", () => {
    expect(ratingsForAudiobook({ adult: true })).toEqual({ certifications: {}, ratingAges: { ANY: 18 } });
  });
  it("flags children's genres as unrestricted", () => {
    expect(ratingsForAudiobook({ genres: ["Children's Audiobooks"] })).toEqual({
      certifications: {},
      ratingAges: { ANY: 0 },
    });
  });
  it("is unrated otherwise", () => {
    expect(ratingsForAudiobook({ genres: ["Science Fiction"] })).toEqual({ certifications: {}, ratingAges: {} });
  });
});

describe("countryFromLocale", () => {
  it("reads the region subtag", () => {
    expect(countryFromLocale("en-GB")).toBe("GB");
    expect(countryFromLocale("fr-CA")).toBe("CA");
  });
  it("defaults to US for a missing or malformed region", () => {
    expect(countryFromLocale("en")).toBe("US");
    expect(countryFromLocale(null)).toBe("US");
    expect(countryFromLocale("en-419")).toBe("US");
  });
});

describe("displayCertification", () => {
  const certs = { GB: "15", FR: "16" };
  it("prefers the viewer's country, then US, then whatever's on file", () => {
    expect(displayCertification(certs, "GB")).toBe("15");
    expect(displayCertification({ US: "R", FR: "16" }, "GB")).toBe("R");
    expect(displayCertification(certs, "DE")).toBe("15");
  });
  it("returns null with nothing on file", () => {
    expect(displayCertification(null, "US")).toBeNull();
    expect(displayCertification({}, "US")).toBeNull();
  });
});
