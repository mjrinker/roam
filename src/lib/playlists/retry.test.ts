import { describe, expect, it, vi } from "vitest";
import { dbErrorCode, retryOnContention } from "./retry";

const pgError = (code: string, wrap = false) => {
  const e = Object.assign(new Error("pg"), { code });
  return wrap ? Object.assign(new Error("Failed query"), { cause: e }) : e;
};

describe("dbErrorCode", () => {
  it("reads the code directly or from a drizzle-wrapped cause", () => {
    expect(dbErrorCode(pgError("40P01"))).toBe("40P01");
    expect(dbErrorCode(pgError("23503", true))).toBe("23503");
    expect(dbErrorCode(new Error("plain"))).toBeUndefined();
    expect(dbErrorCode(null)).toBeUndefined();
  });
});

describe("retryOnContention", () => {
  it("retries on a deadlock or serialization failure, then succeeds", async () => {
    for (const code of ["40P01", "40001"]) {
      const fn = vi.fn().mockRejectedValueOnce(pgError(code, true)).mockResolvedValueOnce("ok");
      expect(await retryOnContention(fn)).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps trying through two failures, and gives up on the third", async () => {
    const twice = vi.fn().mockRejectedValueOnce(pgError("40P01")).mockRejectedValueOnce(pgError("40P01")).mockResolvedValueOnce("ok");
    expect(await retryOnContention(twice)).toBe("ok");
    expect(twice).toHaveBeenCalledTimes(3);

    const always = vi.fn().mockRejectedValue(pgError("40P01"));
    await expect(retryOnContention(always)).rejects.toMatchObject({ code: "40P01" });
    expect(always).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors", async () => {
    const fn = vi.fn().mockRejectedValue(pgError("23505"));
    await expect(retryOnContention(fn)).rejects.toMatchObject({ code: "23505" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("can be told to retry other codes (e.g. a foreign-key violation)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(pgError("23503")).mockResolvedValueOnce("ok");
    expect(await retryOnContention(fn, ["23503"])).toBe("ok");
  });
});
