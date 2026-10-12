import { describe, expect, it } from "vitest";
import { availableProviders } from "./available";

describe("which storage can be connected", () => {
  it("offers a kind only when its app keys are both set", () => {
    expect(availableProviders({})).toEqual([]);
    expect(availableProviders({ BOX_CLIENT_ID: "a", BOX_CLIENT_SECRET: "b" })).toEqual(["box"]);
    expect(availableProviders({ BOX_CLIENT_ID: "a", BOX_CLIENT_SECRET: "b", DROPBOX_APP_KEY: "k" })).toEqual(["box"]);
    expect(availableProviders({ BOX_CLIENT_ID: "a", BOX_CLIENT_SECRET: "b", DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" })).toEqual(["box", "dropbox"]);
    expect(availableProviders({ MICROSOFT_CLIENT_ID: "i", MICROSOFT_CLIENT_SECRET: "s" })).toEqual(["onedrive"]);
    expect(availableProviders({ GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s" })).toEqual(["gdrive"]);
  });
});
