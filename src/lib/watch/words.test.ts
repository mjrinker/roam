import { describe, expect, it } from "vitest";
import { doneKindOf, doneWords } from "./words";

describe("what done is called", () => {
  it("says watched for things you watch, listened to for audio, read for books", () => {
    expect(doneWords("watch")).toMatchObject({ done: "Watched", markDone: "Mark as watched", markUndone: "Mark as unwatched" });
    expect(doneWords("listen")).toMatchObject({ done: "Listened to", markDone: "Mark as listened to", markUndone: "Mark as not listened to" });
    expect(doneWords("read")).toMatchObject({ done: "Read", markDone: "Mark as read", markUndone: "Mark as unread", doneToast: "Marked as read" });
  });
  it("picks the words from the kind of title", () => {
    expect([doneKindOf("movie"), doneKindOf("show"), doneKindOf("audiobook"), doneKindOf("ebook")]).toEqual(["watch", "watch", "listen", "read"]);
  });
});
