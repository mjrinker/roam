import { describe, expect, it } from "vitest";
import { isStorageDownloadHost } from "./hosts";

describe("download hosts Roam will redirect to", () => {
  const app = "https://roam.example.com";
  it("accepts Box, Dropbox, OneDrive and this site, over https", () => {
    for (const url of [
      "https://public.boxcloud.com/x",
      "https://dl.dropboxusercontent.com/t/abc",
      "https://uc123.dl.dropboxusercontent.com/cd/0/get/x",
      "https://my.microsoftpersonalcontent.com/personal/abc/_layouts/15/download.aspx?UniqueId=1",
      "https://contoso-my.sharepoint.com/personal/x/_layouts/15/download.aspx",
      "https://roam.example.com/api/storage/stream/abc",
    ]) expect(isStorageDownloadHost(url, app), url).toBe(true);
  });
  it("refuses other hosts, look-alikes, plain http, and embedded logins", () => {
    for (const url of [
      "https://evil.example.com/x",
      "https://dropboxusercontent.com.evil.com/x",
      "https://notdropbox.com/x",
      "https://sharepoint.com.evil.example/x",
      "http://dl.dropboxusercontent.com/x",
      "https://user:pw@dl.dropboxusercontent.com/x",
      "https://roam.example.com.evil.com/x",
      "not a url",
    ]) expect(isStorageDownloadHost(url, app), url).toBe(false);
    expect(isStorageDownloadHost("https://roam.example.com/x", undefined)).toBe(false); // no site configured: only the providers
  });
});
