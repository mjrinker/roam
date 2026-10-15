"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OWNABLE_KIND_LABEL, OWNABLE_LIBRARY_KINDS } from "@/lib/libraries/profile";
import type { ClaimRow } from "@/lib/ownership/owners";
import type { OwnershipSettings } from "@/lib/ownership/rules";

const send = (url: string, method: string, body: unknown) => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface ClaimView extends Omit<ClaimRow, "createdAt"> {
  createdAt: string;
}

/** The server admin's ownership controls: switch it on, how claims are settled, the limit on playing at once, claims waiting for review, and assigning whole libraries. */
export function OwnershipManager({
  serverId,
  initial,
  claims,
}: {
  serverId: string;
  initial: OwnershipSettings;
  claims: ClaimView[];
}) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});

  async function save(patch: Partial<OwnershipSettings>) {
    setBusy(true);
    try {
      const res = await send(`/api/servers/${serverId}/ownership`, "PUT", patch);
      if (!res.ok) throw new Error();
      setS((await res.json()) as OwnershipSettings);
      router.refresh();
    } catch {
      toast.error("Couldn't save that change.");
    } finally {
      setBusy(false);
    }
  }
  async function decide(claim: ClaimView, body: { kind: "approve" } | { kind: "reject"; note?: string } | { kind: "evidence"; note: string }, done: string) {
    setBusy(true);
    try {
      const res = await send(`/api/ownership/claims/${claim.id}/decision`, "POST", body);
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error);
      toast.success(done);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message || "Couldn't do that.");
    } finally {
      setBusy(false);
    }
  }
  const kinds: readonly string[] = OWNABLE_LIBRARY_KINDS;
  return (
    <section className="flex flex-col gap-3" id="claims">
      <h2 className="text-lg font-semibold">Who owns what</h2>
      <Card>
        <CardContent className="flex flex-col gap-5 py-4">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 size-4" checked={s.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} />
            <span>
              <strong>Track who owns each title.</strong> Households can claim the movies, seasons and books they own copies of, and withdraw a copy. Until a title is claimed, everyone can watch it.
            </span>
          </label>

          {s.enabled && (
            <>
              <fieldset className="flex min-w-0 flex-col gap-2 text-sm" disabled={busy}>
                <legend className="mb-1 font-medium">When someone claims they own a title</legend>
                <label className="flex items-start gap-2">
                  <input type="radio" name="claim-mode" className="mt-1" checked={s.claimMode === "review"} onChange={() => save({ claimMode: "review" })} />
                  <span>It goes to me for review. I can accept it, or ask for evidence (such as a photo of the disc).</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" name="claim-mode" className="mt-1" checked={s.claimMode === "instant"} onChange={() => save({ claimMode: "instant" })} />
                  <span>Accept it straight away.</span>
                </label>
              </fieldset>

              <fieldset className="flex min-w-0 flex-col gap-2 text-sm" disabled={busy}>
                <legend className="mb-1 font-medium">Playing at once</legend>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={s.limitConcurrent} onChange={(e) => save({ limitConcurrent: e.target.checked })} />
                  <span>No more people can watch a title at once than there are shared copies of it. A show counts per season. Someone who&apos;s too many gets a message, and can ask to be told when a copy is free.</span>
                </label>
                {s.limitConcurrent && (
                  <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
                    {kinds.map((k) => (
                      <label key={k} className="flex items-center gap-1.5">
                        <input type="checkbox" checked={s.limitKinds.includes(k)} onChange={(e) => save({ limitKinds: e.target.checked ? [...s.limitKinds, k] : s.limitKinds.filter((x) => x !== k) })} />
                        {OWNABLE_KIND_LABEL[k as keyof typeof OWNABLE_KIND_LABEL]}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

              <div className="flex flex-col gap-2 text-sm">
                <h3 className="font-medium">Claims waiting for you</h3>
                {claims.length === 0 ? (
                  <p className="text-muted-foreground">None right now.</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {claims.map((c) => (
                      <li key={c.id} className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/10">
                        <p>
                          <strong>{c.household}</strong> says they own <strong>{c.titleName}</strong>
                          {c.seasonNumber !== null ? `, season ${c.seasonNumber}` : ""}.{" "}
                          <span className="text-muted-foreground">
                            {c.status === "evidence_requested" ? "Waiting for the evidence you asked for." : c.status === "evidence_submitted" ? "Evidence sent." : ""}
                          </span>
                        </p>
                        {c.pictures.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {c.pictures.map((p) => (
                              <a key={p.id} href={`/api/ownership/claims/${c.id}/pictures/${p.id}`} target="_blank" rel="noopener noreferrer">
                                {/* eslint-disable-next-line @next/next/no-img-element -- a private picture sent as evidence; next/image can't fetch it */}
                                <img src={`/api/ownership/claims/${c.id}/pictures/${p.id}`} alt="Evidence sent with the claim" className="h-24 rounded-lg object-cover ring-1 ring-white/15" />
                              </a>
                            ))}
                          </div>
                        )}
                        <input
                          type="text"
                          aria-label="A note for them (asking for evidence needs one)"
                          placeholder="A note for them (needed to ask for evidence)"
                          maxLength={500}
                          className="h-9 rounded-lg bg-white/[0.06] px-3 text-sm ring-1 ring-white/10"
                          value={note[c.id] ?? ""}
                          onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" disabled={busy} onClick={() => decide(c, { kind: "approve" }, "Accepted.")}>
                            Accept
                          </Button>
                          <Button type="button" variant="secondary" disabled={busy || !(note[c.id] ?? "").trim()} onClick={() => decide(c, { kind: "evidence", note: (note[c.id] ?? "").trim() }, "Asked for evidence.")}>
                            Ask for evidence
                          </Button>
                          <Button type="button" variant="ghost" disabled={busy} onClick={() => decide(c, { kind: "reject", note: (note[c.id] ?? "").trim() || undefined }, "Turned down.")}>
                            Turn down
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
