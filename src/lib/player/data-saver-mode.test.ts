import { describe, expect, it } from "vitest";
import { connectionIsMetered, dataSaverParam, describeDataSaver, effectiveDataSaver, readDataSaverMode, writeDataSaverMode } from "./data-saver-mode";

describe("what the browser says about the connection", () => {
  it("calls mobile data and the browser's own data saver metered, Wi-Fi and wired not, and anything else unknown", () => {
    expect(connectionIsMetered({ type: "cellular" })).toBe(true);
    expect(connectionIsMetered({ type: "wifi", saveData: true })).toBe(true);
    expect(connectionIsMetered({ type: "wifi" })).toBe(false);
    expect(connectionIsMetered({ type: "ethernet" })).toBe(false);
    expect(connectionIsMetered({})).toBeNull();
    expect(connectionIsMetered({ type: "unknown" })).toBeNull();
    expect(connectionIsMetered(undefined)).toBeNull();
  });
});

describe("whether data saver is on for a device", () => {
  it("follows the profile unless the device says otherwise", () => {
    expect(effectiveDataSaver("profile", true, false)).toBe(true);
    expect(effectiveDataSaver("profile", false, true)).toBe(false);
    expect(effectiveDataSaver("on", false, false)).toBe(true);
    expect(effectiveDataSaver("off", true, true)).toBe(false);
  });
  it("on automatic follows the connection, and the profile where the connection is unknown", () => {
    expect(effectiveDataSaver("auto", false, true)).toBe(true);
    expect(effectiveDataSaver("auto", true, false)).toBe(false);
    expect(effectiveDataSaver("auto", true, null)).toBe(true);
    expect(effectiveDataSaver("auto", false, null)).toBe(false);
  });
  it("describes itself, and sends the server a value only when the device has chosen", () => {
    expect(describeDataSaver("auto", false, true)).toBe("On (mobile data)");
    expect(describeDataSaver("auto", true, false)).toBe("Off (Wi-Fi)");
    expect(describeDataSaver("auto", true, null)).toBe("On (profile setting)");
    expect(describeDataSaver("off", true, null)).toBe("Off on this device");
    expect(dataSaverParam("profile", true)).toBeNull();
    expect(dataSaverParam("auto", true)).toBe("1");
    expect(dataSaverParam("off", false)).toBe("0");
  });
});

describe("the remembered choice", () => {
  it("round-trips, ignores nonsense, and shrugs at blocked storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readDataSaverMode(storage)).toBe("profile");
    writeDataSaverMode("auto", storage);
    expect(readDataSaverMode(storage)).toBe("auto");
    store.set("roam-data-saver-mode", "bogus");
    expect(readDataSaverMode(storage)).toBe("profile");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readDataSaverMode(broken)).toBe("profile");
    expect(() => writeDataSaverMode("on", broken)).not.toThrow();
  });
});
