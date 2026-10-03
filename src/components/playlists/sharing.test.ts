import { describe, expect, it } from "vitest";
import { canChangeRole, canRemoveShare, defaultRole, pickCandidates, showShareButton, type ShareCaps, type ShareRow } from "./sharing";

const owner: ShareCaps = { share: true, grantRoles: ["viewer", "sharer", "editor"], manageMembers: true, makePublic: true, makePrivate: true };
const sharer: ShareCaps = { share: true, grantRoles: ["viewer"], manageMembers: false, makePublic: false, makePrivate: false };
const editor: ShareCaps = { share: false, grantRoles: [], manageMembers: false, makePublic: false, makePrivate: false };
const limitedOwner: ShareCaps = { ...owner, makePublic: false };

const row = (over: Partial<ShareRow> = {}): ShareRow => ({ id: "v1", role: "viewer", isMe: false, grantedByMe: false, ...over });

describe("showShareButton", () => {
  it("shows for anyone who can share, manage, or change visibility, and for nobody else", () => {
    expect(showShareButton(owner)).toBe(true);
    expect(showShareButton(sharer)).toBe(true);
    expect(showShareButton(limitedOwner)).toBe(true);
    expect(showShareButton({ ...editor, makePrivate: true })).toBe(true); // a limited owner of a public playlist can still take it private
    expect(showShareButton(editor)).toBe(false);
  });
});

describe("canRemoveShare / canChangeRole", () => {
  it("the owner removes anyone but themselves and changes any role", () => {
    expect(canRemoveShare(owner, row({ role: "editor" }))).toBe(true);
    expect(canRemoveShare(owner, row({ isMe: true }))).toBe(false);
    expect(canChangeRole(owner, row({ role: "sharer" }))).toBe(true);
    expect(canChangeRole(owner, row({ isMe: true }))).toBe(false);
  });

  it("a sharer removes only viewer shares it granted, and changes no roles", () => {
    expect(canRemoveShare(sharer, row({ grantedByMe: true }))).toBe(true);
    expect(canRemoveShare(sharer, row({ grantedByMe: false }))).toBe(false);
    expect(canRemoveShare(sharer, row({ role: "editor", grantedByMe: true }))).toBe(false);
    expect(canChangeRole(sharer, row({ grantedByMe: true }))).toBe(false);
  });

  it("an editor manages nobody", () => {
    expect(canRemoveShare(editor, row({ grantedByMe: true }))).toBe(false);
    expect(canChangeRole(editor, row())).toBe(false);
  });
});

describe("pickCandidates", () => {
  const people = [
    { id: "a", name: "Alice" },
    { id: "b", name: "Bob" },
    { id: "c", name: "Carol" },
  ];
  it("drops the owner and anyone already shared with", () => {
    expect(pickCandidates(people, new Set(["b"]), "a", "").map((p) => p.id)).toEqual(["c"]);
  });
  it("filters by a case-insensitive name search, ignoring surrounding spaces", () => {
    expect(pickCandidates(people, new Set(), null, "  CAR ").map((p) => p.id)).toEqual(["c"]);
    expect(pickCandidates(people, new Set(), null, "zzz")).toEqual([]);
  });
});

describe("defaultRole", () => {
  it("starts at the weakest role the actor may grant", () => {
    expect(defaultRole(["viewer", "sharer", "editor"])).toBe("viewer");
    expect(defaultRole(["editor"])).toBe("editor");
    expect(defaultRole([])).toBe("viewer");
  });
});
