import { describe, expect, it } from "vitest";
import {
  capabilities,
  effectiveRole,
  isOrphaned,
  type ActorFacts,
  type MemberRole,
  type PlaylistFacts,
} from "./permissions";

const OWNER = "viewer-owner";
const ACTOR = "viewer-actor";

const playlist = (over: Partial<PlaylistFacts> = {}): PlaylistFacts => ({
  ownerViewerId: OWNER,
  ownerAccountIsMember: true,
  visibility: "private",
  ...over,
});
const actor = (over: Partial<ActorFacts> = {}): ActorFacts => ({
  viewerId: ACTOR,
  accountId: "acct-actor",
  viewerRole: "admin",
  isServerMember: true,
  isServerAdmin: false,
  ...over,
});

describe("effectiveRole", () => {
  it("is null for a non-member of the server on every path", () => {
    const outsider = actor({ isServerMember: false });
    expect(effectiveRole(playlist({ visibility: "server" }), outsider, "editor")).toBeNull();
    expect(effectiveRole(playlist({ ownerViewerId: ACTOR }), outsider, null)).toBeNull();
  });

  it("gives the owner owner", () => {
    expect(effectiveRole(playlist({ ownerViewerId: ACTOR }), actor(), null)).toBe("owner");
  });

  it("uses a direct share's role", () => {
    for (const r of ["editor", "sharer", "viewer"] as MemberRole[]) {
      expect(effectiveRole(playlist(), actor(), r)).toBe(r);
    }
  });

  it("gives viewer for a public playlist and nothing for a private one", () => {
    expect(effectiveRole(playlist({ visibility: "server" }), actor(), null)).toBe("viewer");
    expect(effectiveRole(playlist(), actor(), null)).toBeNull();
  });

  it("prefers a share over public visibility", () => {
    expect(effectiveRole(playlist({ visibility: "server" }), actor(), "editor")).toBe("editor");
  });

  it("caps everything at viewer when the playlist has no owner", () => {
    const orphan = playlist({ ownerViewerId: null });
    expect(effectiveRole(orphan, actor(), "editor")).toBe("viewer");
    expect(effectiveRole(orphan, actor(), "sharer")).toBe("viewer");
    expect(effectiveRole(orphan, actor(), "viewer")).toBe("viewer");
  });

  it("caps everything at viewer when the owner's account left the server", () => {
    const exMember = playlist({ ownerAccountIsMember: false });
    expect(effectiveRole(exMember, actor(), "editor")).toBe("viewer");
    expect(effectiveRole({ ...exMember, ownerViewerId: ACTOR }, actor(), null)).toBe("viewer");
  });

  it("isOrphaned covers both orphan cases", () => {
    expect(isOrphaned(playlist())).toBe(false);
    expect(isOrphaned(playlist({ ownerViewerId: null }))).toBe(true);
    expect(isOrphaned(playlist({ ownerAccountIsMember: false }))).toBe(true);
  });
});

describe("capabilities", () => {
  const caps = (p: PlaylistFacts, a: ActorFacts, m: MemberRole | null) => capabilities(p, a, m);

  it("owner can do everything", () => {
    const c = caps(playlist({ ownerViewerId: ACTOR }), actor(), null);
    expect(c).toMatchObject({
      canView: true,
      canPlay: true,
      canCopy: true,
      canEditItems: true,
      canRename: true,
      canTransfer: true,
      canDelete: true,
      canLeave: false,
    });
    expect(c.canSetVisibility("server")).toBe(true);
    expect(c.canShare("editor", "acct-other")).toBe(true);
    expect(c.canRevoke({ viewerId: "x", role: "editor", grantedByViewerId: null })).toBe(true);
  });

  it("editor edits items and renames but cannot manage people, visibility, transfer or delete", () => {
    const c = caps(playlist(), actor(), "editor");
    expect(c).toMatchObject({ canEditItems: true, canRename: true, canTransfer: false, canDelete: false, canLeave: true });
    expect(c.canSetVisibility("server")).toBe(false);
    expect(c.canShare("viewer", "acct-other")).toBe(false);
    expect(c.canRevoke({ viewerId: "x", role: "viewer", grantedByViewerId: ACTOR })).toBe(false);
  });

  it("sharer can grant viewer only, and revoke only viewer rows it granted", () => {
    const c = caps(playlist(), actor(), "sharer");
    expect(c.canEditItems).toBe(false);
    expect(c.canShare("viewer", "acct-other")).toBe(true);
    expect(c.canShare("sharer", "acct-other")).toBe(false);
    expect(c.canShare("editor", "acct-other")).toBe(false);
    expect(c.canRevoke({ viewerId: "x", role: "viewer", grantedByViewerId: ACTOR })).toBe(true);
    expect(c.canRevoke({ viewerId: "x", role: "viewer", grantedByViewerId: "someone-else" })).toBe(false);
    expect(c.canRevoke({ viewerId: "x", role: "editor", grantedByViewerId: ACTOR })).toBe(false);
  });

  it("viewer can only view, play, copy and leave", () => {
    const c = caps(playlist(), actor(), "viewer");
    expect(c).toMatchObject({ canView: true, canPlay: true, canCopy: true, canLeave: true, canEditItems: false, canRename: false, canDelete: false });
    expect(c.canShare("viewer", "acct-other")).toBe(false);
  });

  it("a public-only reader can view and copy but has no share to leave", () => {
    const c = caps(playlist({ visibility: "server" }), actor(), null);
    expect(c).toMatchObject({ canView: true, canCopy: true, canLeave: false, canDelete: false });
  });

  it("an outsider (no access) can do nothing", () => {
    const c = caps(playlist(), actor(), null);
    expect(c.role).toBeNull();
    expect(c).toMatchObject({ canView: false, canPlay: false, canCopy: false, canEditItems: false, canDelete: false, canLeave: false });
  });

  it("orphaned playlists are view-only: no edits, shares or revokes, but members may leave", () => {
    for (const orphan of [playlist({ ownerViewerId: null }), playlist({ ownerAccountIsMember: false })]) {
      const c = caps(orphan, actor(), "editor");
      expect(c).toMatchObject({ canView: true, canEditItems: false, canRename: false, canTransfer: false, canDelete: false, canLeave: true });
      expect(c.canShare("viewer", "acct-other")).toBe(false);
      expect(c.canRevoke({ viewerId: "x", role: "viewer", grantedByViewerId: ACTOR })).toBe(false);
    }
  });

  it("a limited actor never expands access beyond its own account", () => {
    const limited = actor({ viewerRole: "limited" });
    const owned = caps(playlist({ ownerViewerId: ACTOR }), limited, null);
    expect(owned.canShare("viewer", "acct-other")).toBe(false);
    expect(owned.canShare("viewer", limited.accountId)).toBe(true);
    expect(owned.canSetVisibility("server")).toBe(false);
    // ... but may always undo access and delete its own playlist.
    expect(owned.canSetVisibility("private")).toBe(true);
    expect(owned.canDelete).toBe(true);
    expect(owned.canRevoke({ viewerId: "x", role: "viewer", grantedByViewerId: ACTOR })).toBe(true);
  });

  it("a limited sharer is also confined to its own account", () => {
    const c = caps(playlist(), actor({ viewerRole: "limited" }), "sharer");
    expect(c.canShare("viewer", "acct-other")).toBe(false);
    expect(c.canShare("viewer", "acct-actor")).toBe(true);
  });

  describe("server admins", () => {
    const admin = actor({ isServerAdmin: true });

    it("may delete a public playlist, owned or not, and nothing else", () => {
      const pub = caps(playlist({ visibility: "server" }), admin, null);
      expect(pub.canDelete).toBe(true);
      expect(pub.canEditItems).toBe(false);
      expect(caps(playlist({ visibility: "server", ownerViewerId: null }), admin, null).canDelete).toBe(true);
    });

    it("sees nothing of a private playlist they are not part of (even an ownerless one)", () => {
      for (const p of [playlist(), playlist({ ownerViewerId: null })]) {
        const c = caps(p, admin, null);
        expect(c.canView).toBe(false);
        expect(c.canDelete).toBe(false);
      }
    });

    it("a limited profile on an admin account gets no admin powers", () => {
      const limitedAdmin = actor({ isServerAdmin: true, viewerRole: "limited" });
      expect(caps(playlist({ visibility: "server" }), limitedAdmin, null).canDelete).toBe(false);
    });

    it("an admin who left the server has no powers", () => {
      expect(caps(playlist({ visibility: "server" }), actor({ isServerAdmin: true, isServerMember: false }), null).canDelete).toBe(false);
    });
  });

  it("exhaustive: no capability is ever granted without view access", () => {
    const owners: (string | null)[] = [OWNER, ACTOR, null];
    const visibilities = ["private", "server"] as const;
    const members: (MemberRole | null)[] = [null, "viewer", "sharer", "editor"];
    for (const ownerViewerId of owners)
      for (const ownerAccountIsMember of [true, false])
        for (const visibility of visibilities)
          for (const m of members)
            for (const isServerMember of [true, false])
              for (const viewerRole of ["owner", "admin", "limited"] as const)
                for (const isServerAdmin of [true, false]) {
                  const p = playlist({ ownerViewerId, ownerAccountIsMember, visibility });
                  const a = actor({ isServerMember, viewerRole, isServerAdmin });
                  const c = capabilities(p, a, m);
                  if (!c.canView) {
                    expect(c.canPlay || c.canCopy || c.canEditItems || c.canRename || c.canTransfer || c.canLeave).toBe(false);
                    expect(c.canShare("viewer", a.accountId)).toBe(false);
                  }
                  if (c.canEditItems) expect(isOrphaned(p)).toBe(false);
                  if (c.canDelete && c.role !== "owner") expect(visibility).toBe("server");
                }
  });
});
