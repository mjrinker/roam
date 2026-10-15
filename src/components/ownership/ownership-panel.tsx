"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { OwnershipView, UnitView } from "@/lib/ownership/view";

const call = (url: string, method: string, body: unknown) => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** A photo shrunk to something small enough to send as evidence. */
async function shrink(file: File): Promise<{ contentType: string; dataBase64: string } | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.6, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return null;
    const data = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.readAsDataURL(blob);
    });
    if (data.length <= 700_000) return { contentType: "image/jpeg", dataBase64: data };
  }
  return null;
}

function UnitRow({ titleId, unit, view, canClaim, isAdmin }: { titleId: string; unit: UnitView; view: OwnershipView; canClaim: boolean; isAdmin: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [household, setHousehold] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const instant = view.settings.claimMode === "instant";
  const what = unit.label ?? "this";

  async function act(fn: () => Promise<Response>, done?: string) {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "That didn't work.");
      if (done) toast.success(done);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const key = { titleId, seasonId: unit.seasonId };
  const claim = unit.myClaim;
  const open = claim && claim.status !== "rejected" ? claim : null;

  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" data-testid="ownership-unit">
      {unit.label && <h3 className="text-sm font-semibold">{unit.label}</h3>}
      <p className="text-sm text-muted-foreground">
        {unit.owners.length === 0
          ? "Nobody has claimed this yet, so everyone can watch it."
          : unit.owners.map((o) => `${o.mine ? "You" : o.name}${o.shared ? "" : " (withdrawn)"}`).join(", ")}
      </p>
      {!unit.playable && <p className="text-sm text-amber-200">Every owner has withdrawn this, so it can&apos;t be played right now.</p>}

      {unit.iOwn ? (
        <div className="flex flex-wrap gap-2">
          {unit.myShared ? (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => act(() => call("/api/ownership/mine", "PUT", { ...key, shared: false }), "Your copy is withdrawn.")}>
              Withdraw my copy
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={() => act(() => call("/api/ownership/mine", "PUT", { ...key, shared: true }), "Your copy is shared again.")}>
              Share my copy again
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Stop saying you own ${what === "this" ? "this" : what.toLowerCase()}?`)) void act(() => call("/api/ownership/mine", "DELETE", key));
            }}
          >
            I don&apos;t own this
          </Button>
          {!unit.myShared && <p className="basis-full text-xs text-muted-foreground">While withdrawn, only you can watch your copy unless another owner shares theirs.</p>}
        </div>
      ) : open ? (
        <div className="flex flex-col gap-2 text-sm">
          {open.status === "pending" && <p>Your claim is waiting for the admin to review it.</p>}
          {open.status === "evidence_submitted" && <p>Your picture was sent. The admin will review it.</p>}
          {open.status === "evidence_requested" && (
            <>
              <p>
                The admin asked for evidence{open.note ? <>: <em>{open.note}</em></> : "."} A photo of the disc or case works (send up to three).
              </p>
              <div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    const picture = await shrink(file);
                    if (!picture) return void toast.error("Couldn't use that picture.");
                    await act(() => call(`/api/ownership/claims/${open.id}/evidence`, "POST", picture), "Picture sent.");
                  }}
                />
                <Button type="button" variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
                  Choose a picture
                </Button>
              </div>
            </>
          )}
        </div>
      ) : canClaim ? (
        <div className="flex flex-col gap-2">
          {claim?.status === "rejected" && <p className="text-sm text-muted-foreground">Your last claim wasn&apos;t accepted{claim.note ? `: ${claim.note}` : "."}</p>}
          <div>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => act(() => call("/api/ownership/claims", "POST", key), instant ? "Added to what you own." : "Sent to the admin for review.")}>
              I own a copy
            </Button>
          </div>
        </div>
      ) : null}

      {isAdmin && (
        <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
          <span className="text-xs text-muted-foreground">Admin:</span>
          <select aria-label={`Make an owner of ${what}`} className="h-9 min-w-0 max-w-full rounded-lg bg-white/[0.06] px-2 text-sm ring-1 ring-white/10" value={household} onChange={(e) => setHousehold(e.target.value)}>
            <option value="">Choose a household…</option>
            {view.households.map((h) => (
              <option key={h.accountId} value={h.accountId}>
                {h.name}
                {h.isAdmin ? " (admin)" : ""}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !household}
            onClick={() => act(() => call("/api/ownership/owners", "PUT", { serverId: view.serverId, accountId: household, action: "assign", units: [key] }), "Owner added.")}
          >
            Add owner
          </Button>
          {unit.owners.map((o) => (
            <Button
              key={o.accountId}
              type="button"
              variant="ghost"
              className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-left"
              disabled={busy}
              onClick={() => act(() => call("/api/ownership/owners", "PUT", { serverId: view.serverId, accountId: o.accountId, action: "remove", units: [key] }), "Owner removed.")}
            >
              Remove {o.mine ? "me" : o.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Who owns a title (a season of a show), with the controls each person has: claim it, withdraw or share their copy, or, for the admin, assign owners. */
export function OwnershipPanel({ titleId, view, canClaim, isAdmin }: { titleId: string; view: OwnershipView; canClaim: boolean; isAdmin: boolean }) {
  return (
    <section className="flex flex-col gap-3" aria-label="Ownership">
      <h2 className="text-lg font-semibold">Who owns it</h2>
      <Card>
        <CardContent className="divide-y divide-white/10 py-4">
          {view.units.map((u) => (
            <UnitRow key={u.seasonId ?? "whole"} titleId={titleId} unit={u} view={view} canClaim={canClaim} isAdmin={isAdmin} />
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
