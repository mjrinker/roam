import { describe, expect, it } from "vitest";
import { placeNameFrom } from "./place-name";

describe("placeNameFrom", () => {
  it("names a place by its landmark, town and state, leaving out the United States", () => {
    expect(placeNameFrom({ address: { leisure: "Emerald Bay State Park", town: "South Lake Tahoe", state: "California", country: "United States", country_code: "us" } })).toBe("Emerald Bay State Park, South Lake Tahoe, California");
    expect(placeNameFrom({ address: { city: "San Francisco", state: "California", country: "United States", country_code: "us" } })).toBe("San Francisco, California");
  });
  it("adds the country abroad, and never repeats a part", () => {
    expect(placeNameFrom({ address: { city: "Paris", state: "Île-de-France", country: "France", country_code: "fr" } })).toBe("Paris, Île-de-France, France");
    expect(placeNameFrom({ address: { city: "Singapore", state: "Singapore", country: "Singapore", country_code: "sg" } })).toBe("Singapore");
  });
  it("falls back to the first parts of the long name, and to nothing when there is none", () => {
    expect(placeNameFrom({ display_name: "Somewhere, Some County, A State, Country", address: {} })).toBe("Somewhere, Some County, A State");
    expect(placeNameFrom({ address: {} })).toBeNull();
    expect(placeNameFrom(null)).toBeNull();
  });
});
