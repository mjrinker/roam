import { describe, expect, it } from "vitest";
import { escapeLike, MAX_QUERY_LENGTH, parseSearch } from "./search";

const range = (q: string) => {
  const r = parseSearch(q)?.range;
  return r ? [r.from.toISOString().slice(0, 10), r.to.toISOString().slice(0, 10)] : null;
};

describe("parseSearch", () => {
  it("is nothing for an empty or non-text query", () => {
    for (const q of [null, undefined, "", "   ", "\n\t", 5 as never]) expect(parseSearch(q), String(q)).toBeNull();
  });
  it("cleans the text: trimmed, spaces collapsed, control characters removed, length capped", () => {
    expect(parseSearch("  beach   day \n")!.text).toBe("beach day");
    expect(parseSearch("a\u0000b\u001fc")!.text).toBe("a b c");
    expect(parseSearch("x".repeat(500))!.text).toHaveLength(MAX_QUERY_LENGTH);
  });
  it("reads a year, a month and a day", () => {
    expect(range("2024")).toEqual(["2024-01-01", "2025-01-01"]);
    expect(range("2024-03")).toEqual(["2024-03-01", "2024-04-01"]);
    expect(range("2024-3")).toEqual(["2024-03-01", "2024-04-01"]);
    expect(range("2024-12")).toEqual(["2024-12-01", "2025-01-01"]);
    expect(range("2024-03-14")).toEqual(["2024-03-14", "2024-03-15"]);
    expect(range("2024-02-29")).toEqual(["2024-02-29", "2024-03-01"]);
  });
  it("reads month names in either order, abbreviated or not", () => {
    for (const q of ["March 2024", "march 2024", "Mar 2024", "Mar. 2024", "2024 March", "2024 mar"]) expect(range(q), q).toEqual(["2024-03-01", "2024-04-01"]);
    expect(range("Sept 2023")).toEqual(["2023-09-01", "2023-10-01"]);
    expect(range("December 2024")).toEqual(["2024-12-01", "2025-01-01"]);
  });
  it("does not guess: impossible dates, ambiguous numeric dates and non-dates are just text", () => {
    for (const q of ["2024-13", "2024-00", "2024-02-30", "2023-02-29", "0000", "1700", "3/4/2024", "03-04-2024", "Marz 2024", "Ma 2024", "beach 2024", "IMG_2024", "12345", "March"]) {
      expect(range(q), q).toBeNull();
    }
  });
  it("keeps the text even when the query is a date, so both are searched", () => {
    expect(parseSearch("2024")!.text).toBe("2024");
  });
});

describe("escapeLike", () => {
  it("escapes the characters that mean something in a LIKE pattern", () => {
    expect(escapeLike("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(escapeLike("plain")).toBe("plain");
  });
});
