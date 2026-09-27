import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { titles } from "@/lib/db/schema";
import { contentFilter, effectiveAge, isAllowed, ratingCountry } from "./access";

const dialect = new PgDialect();
const render = (sqlExpr: ReturnType<typeof contentFilter>) =>
  sqlExpr ? dialect.sqlToQuery(sqlExpr) : null;

describe("ratingCountry", () => {
  it("is countryFromLocale re-exported", () => {
    expect(ratingCountry("en-GB")).toBe("GB");
    expect(ratingCountry("en")).toBe("US");
  });
});

describe("effectiveAge", () => {
  it("prefers the given country, then US, then the catch-all ANY flag", () => {
    expect(effectiveAge({ GB: 15, US: 17 }, "GB")).toBe(15);
    expect(effectiveAge({ US: 17 }, "GB")).toBe(17);
    expect(effectiveAge({ ANY: 18 }, "GB")).toBe(18);
  });
  it("is null with nothing on file", () => {
    expect(effectiveAge(null, "US")).toBeNull();
    expect(effectiveAge({}, "US")).toBeNull();
  });
});

describe("isAllowed", () => {
  const unrestricted = { locale: "en-US", maxAge: null, allowUnrated: false };
  const pg13 = { locale: "en-US", maxAge: 13, allowUnrated: false };
  const pg13AllowUnrated = { locale: "en-US", maxAge: 13, allowUnrated: true };
  const gbProfile = { locale: "en-GB", maxAge: 12, allowUnrated: false };

  it("an unrestricted profile allows anything, rated or not", () => {
    expect(isAllowed(unrestricted, { US: 17 })).toBe(true);
    expect(isAllowed(unrestricted, null)).toBe(true);
  });

  it("allows content at or under the limit, blocks over it", () => {
    expect(isAllowed(pg13, { US: 13 })).toBe(true);
    expect(isAllowed(pg13, { US: 10 })).toBe(true);
    expect(isAllowed(pg13, { US: 17 })).toBe(false);
  });

  it("blocks unrated content unless allowUnrated is on", () => {
    expect(isAllowed(pg13, null)).toBe(false);
    expect(isAllowed(pg13, {})).toBe(false);
    expect(isAllowed(pg13AllowUnrated, null)).toBe(true);
  });

  it("uses the profile's own country's rating", () => {
    expect(isAllowed(gbProfile, { GB: 12, US: 17 })).toBe(true);
    expect(isAllowed(gbProfile, { US: 17 })).toBe(false);
  });
});

describe("contentFilter", () => {
  it("is undefined (no-op) for an unrestricted profile", () => {
    expect(contentFilter({ locale: "en-US", maxAge: null, allowUnrated: false }, titles.ratingAges)).toBeUndefined();
  });

  it("renders a bound query excluding unrated content by default", () => {
    const rendered = render(contentFilter({ locale: "en-US", maxAge: 13, allowUnrated: false }, titles.ratingAges));
    expect(rendered?.sql).toMatchInlineSnapshot(
      `"(COALESCE(("titles"."rating_ages"->>$1)::int, ("titles"."rating_ages"->>'US')::int, ("titles"."rating_ages"->>'ANY')::int) IS NOT NULL AND COALESCE(("titles"."rating_ages"->>$2)::int, ("titles"."rating_ages"->>'US')::int, ("titles"."rating_ages"->>'ANY')::int) <= $3)"`
    );
    expect(rendered?.params).toEqual(["US", "US", 13]);
  });

  it("renders an OR-IS-NULL query when unrated content is allowed", () => {
    const rendered = render(contentFilter({ locale: "en-GB", maxAge: 12, allowUnrated: true }, titles.ratingAges));
    expect(rendered?.sql).toMatchInlineSnapshot(
      `"(COALESCE(("titles"."rating_ages"->>$1)::int, ("titles"."rating_ages"->>'US')::int, ("titles"."rating_ages"->>'ANY')::int) IS NULL OR COALESCE(("titles"."rating_ages"->>$2)::int, ("titles"."rating_ages"->>'US')::int, ("titles"."rating_ages"->>'ANY')::int) <= $3)"`
    );
    expect(rendered?.params).toEqual(["GB", "GB", 12]);
  });
});
