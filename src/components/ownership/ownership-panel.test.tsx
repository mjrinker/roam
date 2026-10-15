import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { OwnershipPanel } from "./ownership-panel";
import { OwnershipManager } from "@/components/admin/ownership-manager";
import { UnavailableScreen } from "@/components/player/unavailable-screen";
import type { OwnershipView, UnitView } from "@/lib/ownership/view";

const unit = (over: Partial<UnitView> = {}): UnitView => ({ seasonId: null, label: null, owners: [], iOwn: false, myShared: false, myClaim: null, playable: true, blockedBy: null, watching: false, ...over });
const view = (units: UnitView[], over: Partial<OwnershipView> = {}): OwnershipView => ({
  serverId: "s1",
  settings: { enabled: true, claimMode: "review", limitConcurrent: false, limitKinds: ["movies", "shows"] },
  units,
  households: [],
  ...over,
});
const panel = (v: OwnershipView, canClaim = true, isAdmin = false) => renderToStaticMarkup(<OwnershipPanel titleId="t1" view={v} canClaim={canClaim} isAdmin={isAdmin} />);

describe("the ownership panel", () => {
  it("says an unclaimed title is open to everyone, and offers a claim", () => {
    const html = panel(view([unit()]));
    expect(html).toContain("Nobody has claimed this yet, so everyone can watch it.");
    expect(html).toContain("I own a copy");
  });
  it("offers no claim to a limited profile", () => {
    expect(panel(view([unit()]), false)).not.toContain("I own a copy");
  });
  it("lets an owner withdraw, and after withdrawing share again, naming owners and marking a withdrawn copy", () => {
    const owners = [{ accountId: "a", name: "Ann", shared: true, mine: true }, { accountId: "b", name: "Bo", shared: false, mine: false }];
    const shared = panel(view([unit({ owners, iOwn: true, myShared: true })]));
    expect(shared).toContain("Withdraw my copy");
    expect(shared).toContain("You, Bo (withdrawn)");
    expect(shared).toContain("I don&#x27;t own this");
    const withdrawn = panel(view([unit({ owners, iOwn: true, myShared: false })]));
    expect(withdrawn).toContain("Share my copy again");
    expect(withdrawn).not.toContain("Withdraw my copy");
  });
  it("warns when every owner has withdrawn", () => {
    expect(panel(view([unit({ owners: [{ accountId: "b", name: "Bo", shared: false, mine: false }], playable: false, blockedBy: "withdrawn" })]))).toContain("can&#x27;t be played right now");
  });
  it("shows each step of a claim", () => {
    expect(panel(view([unit({ myClaim: { id: "c", status: "pending", note: null } })]))).toContain("waiting for the admin to review");
    const asked = panel(view([unit({ myClaim: { id: "c", status: "evidence_requested", note: "photo of the case" } })]));
    expect(asked).toContain("photo of the case");
    expect(asked).toContain("Choose a picture");
    expect(panel(view([unit({ myClaim: { id: "c", status: "evidence_submitted", note: null } })]))).toContain("The admin will review it");
    const turnedDown = panel(view([unit({ myClaim: { id: "c", status: "rejected", note: "Not on the shelf" } })]));
    expect(turnedDown).toContain("Not on the shelf");
    expect(turnedDown).toContain("I own a copy"); // and can try again
  });
  it("words an instant claim the same way but a show is claimed one season at a time", () => {
    const html = panel(view([unit({ seasonId: "s1", label: "Season 1" }), unit({ seasonId: "s2", label: "Season 2", iOwn: true, myShared: true, owners: [{ accountId: "a", name: "Ann", shared: true, mine: true }] })]));
    expect(html.match(/data-testid="ownership-unit"/g)).toHaveLength(2);
    expect(html).toContain("Season 1");
    expect(html).toContain("Season 2");
    expect(html.match(/I own a copy/g)).toHaveLength(1); // only for the season they don't own
  });
  it("gives the admin the owner controls and nobody else", () => {
    const owners = [{ accountId: "b", name: "Bo", shared: true, mine: false }];
    const v = view([unit({ owners })], { households: [{ accountId: "a", name: "Ann", isAdmin: false }, { accountId: "b", name: "Bo", isAdmin: true }] });
    const admin = panel(v, true, true);
    expect(admin).toContain("Add owner");
    expect(admin).toContain("Remove Bo");
    expect(admin).toContain("Bo (admin)");
    expect(panel(v, true, false)).not.toContain("Add owner");
  });
});

describe("the admin's ownership card", () => {
  const settings = { enabled: true, claimMode: "review" as const, limitConcurrent: true, limitKinds: ["movies"] };
  const claim = { id: "c1", titleId: "t", titleName: "Fellowship", seasonNumber: null, accountId: "a", household: "Ann", status: "evidence_submitted" as const, adminNote: null, createdAt: "2026-10-20T00:00:00Z", pictures: [{ id: "p1", contentType: "image/jpeg" }] };
  const card = (s: typeof settings, claims: (typeof claim)[] = []) =>
    renderToStaticMarkup(<OwnershipManager serverId="s1" initial={s} claims={claims} households={[{ accountId: "a", name: "Ann", isAdmin: false }]} libraries={[{ id: "l", name: "Movies", kind: "movies" }]} />);
  it("is just the switch while ownership is off", () => {
    const html = card({ ...settings, enabled: false });
    expect(html).toContain("Track who owns each title");
    expect(html).not.toContain("Playing at once");
  });
  it("offers the two ways to settle claims, the limit with its kinds, and the claim queue", () => {
    const html = card(settings, [claim]);
    expect(html).toContain("It goes to me for review");
    expect(html).toContain("Accept it straight away");
    expect(html).toContain("Playing at once");
    expect(html).toContain("TV shows");
    expect(html).toContain("Ann</strong> says they own <strong>Fellowship");
    expect(html).toContain("/api/ownership/claims/c1/pictures/p1");
    expect(html).toContain("Ask for evidence");
    expect(html).toContain("Assign a whole library");
  });
  it("says when nothing is waiting", () => {
    expect(card(settings)).toContain("None right now.");
  });
});

describe("the waiting screen", () => {
  const unit1 = { titleId: "t", seasonId: null };
  it("lets someone wait for a busy title and be told", () => {
    const html = renderToStaticMarkup(<UnavailableScreen info={{ code: "busy", error: "The only copy is being played right now.", unit: unit1, watching: false }} backHref="/x" onRetry={() => undefined} />);
    expect(html).toContain("The only copy is being played right now.");
    expect(html).toContain("Tell me when it&#x27;s free");
    expect(html).toContain("starts as soon as a copy is free");
  });
  it("offers nothing to wait for when every copy is withdrawn", () => {
    const html = renderToStaticMarkup(<UnavailableScreen info={{ code: "withdrawn", error: "Withdrawn.", unit: unit1, watching: false }} backHref="/x" onRetry={() => undefined} />);
    expect(html).not.toContain("Tell me");
    expect(html).toContain("Go back");
  });
});
