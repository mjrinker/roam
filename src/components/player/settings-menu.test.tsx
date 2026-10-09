import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsMenu } from "./settings-menu";
import { readPreferredHeight, writePreferredHeight } from "@/lib/player/quality-preference";

const noop = () => undefined;
const base = { rate: 1, onRate: noop, ownerKind: "title", ownerId: "t", tracks: [], activeTrack: null, onSelectTrack: noop, onLoadedTrack: noop, subtitleOffset: 0, onSubtitleOffset: noop, qualities: [], quality: "", onQuality: noop };

describe("the settings button", () => {
  it("is one gear, closed to begin with, announcing a menu", () => {
    const html = renderToStaticMarkup(<SettingsMenu {...base} />);
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });
});

describe("the remembered resolution", () => {
  it("round-trips a height through storage and ignores nonsense", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readPreferredHeight(storage)).toBeNull();
    writePreferredHeight(1080, storage);
    expect(readPreferredHeight(storage)).toBe(1080);
    writePreferredHeight(null, storage);
    expect(readPreferredHeight(storage)).toBe(1080);
    store.set("roam-preferred-height", "abc");
    expect(readPreferredHeight(storage)).toBeNull();
    store.set("roam-preferred-height", "99999");
    expect(readPreferredHeight(storage)).toBeNull();
  });
  it("shrugs when storage is missing or throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readPreferredHeight(broken)).toBeNull();
    expect(() => writePreferredHeight(720, broken)).not.toThrow();
    expect(readPreferredHeight(undefined)).toBeNull();
  });
});
