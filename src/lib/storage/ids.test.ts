import { describe, expect, it } from "vitest";
import { formatStorageId, isOriginalBoxId, parseStorageId } from "./ids";

const SERVER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("stored storage ids", () => {
  it("leaves the server's original connection's ids exactly as they were", () => {
    expect(formatStorageId(SERVER, SERVER, "123456")).toBe("123456");
    expect(parseStorageId(SERVER, "123456")).toEqual({ connectionId: SERVER, nativeId: "123456" });
    expect(isOriginalBoxId("123456")).toBe(true);
  });
  it("names the connection for any other, and reads it back whatever the provider's id looks like", () => {
    for (const native of ["abc", "id:AbC123", "/Movies/The Film (2001)/film.mp4", "01ABC!123", "a:b:c", "line\nbreak"]) {
      const stored = formatStorageId(SERVER, OTHER, native);
      expect(stored).toBe(`cn_${OTHER}:${native}`);
      expect(parseStorageId(SERVER, stored)).toEqual({ connectionId: OTHER, nativeId: native });
      expect(isOriginalBoxId(stored)).toBe(false);
    }
  });
  it("keeps the 'file:' keys of single-file items readable", () => {
    const key = `file:${formatStorageId(SERVER, OTHER, "x1")}`;
    expect(parseStorageId(SERVER, key.slice(5))).toEqual({ connectionId: OTHER, nativeId: "x1" });
  });
});
