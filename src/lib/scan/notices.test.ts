import { describe, expect, it } from "vitest";
import { isScanNotice, splitScanMessages } from "./notices";

describe("scan notices", () => {
  it("treats files left out on purpose as notices and everything else as errors", () => {
    expect(isScanNotice("1 file skipped: unsupported format (Roam shows .jpg).")).toBe(true);
    expect(isScanNotice("Trips: 2 files are already part of another library and were skipped.")).toBe(true);
    expect(isScanNotice("1 file is already part of another library and was skipped.")).toBe(true);
    expect(isScanNotice("Box 500: server error")).toBe(false);
    expect(splitScanMessages(["3 files skipped: unsupported format (x).", "boom"])).toEqual({ errors: ["boom"], notices: ["3 files skipped: unsupported format (x)."] });
  });
});
