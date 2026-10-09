import { describe, expect, it } from "vitest";
import { redirectTo } from "./http";

const go = (from: string, to: string) => redirectTo(new Request(`https://roam.example${from}`), to).headers.get("location");

describe("redirectTo", () => {
  it("sends the TV where asked", () => {
    expect(go("/t", "/tv")).toBe("https://roam.example/tv");
  });
  it("carries the switch for the newer-browser extras along, so /t?modern=0 still reaches the page that reads it", () => {
    expect(go("/t?modern=0", "/tv")).toBe("https://roam.example/tv?modern=0");
    expect(go("/tv?modern=1", "/tv/pair")).toBe("https://roam.example/tv/pair?modern=1");
    expect(go("/tv?modern=0", "/tv/s/abc")).toBe("https://roam.example/tv/s/abc?modern=0");
  });
  it("adds it after a query already on the target, keeps a fragment, and never doubles it", () => {
    expect(go("/x?modern=0", "/tv/s/a/library/b?path=Trips")).toBe("https://roam.example/tv/s/a/library/b?path=Trips&modern=0");
    expect(go("/x?modern=0", "/tv/s/a/photo/b?saver=1#slide")).toBe("https://roam.example/tv/s/a/photo/b?saver=1&modern=0#slide");
    expect(go("/x?modern=0", "/tv?modern=1")).toBe("https://roam.example/tv?modern=1");
  });
  it("ignores anything else in that parameter", () => {
    for (const junk of ["2", "x", "", "<script>", "0%00"]) expect(go(`/t?modern=${junk}`, "/tv"), junk).toBe("https://roam.example/tv");
  });
});
