import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));

import { addedMessage } from "./add-songs-to-playlist-menu";

describe("addedMessage", () => {
  it("says how many songs went in and how many were already there, with singular and plural", () => {
    expect(addedMessage("Road trip", 11, 0)).toBe('Added 11 songs to "Road trip".');
    expect(addedMessage("Road trip", 1, 0)).toBe('Added 1 song to "Road trip".');
    expect(addedMessage("Road trip", 8, 3)).toBe('Added 8 songs to "Road trip" (3 already there).');
    expect(addedMessage("Road trip", 0, 1)).toBe('All 1 song was already in "Road trip".');
    expect(addedMessage("Road trip", 0, 12)).toBe('All 12 songs were already in "Road trip".');
  });
});
