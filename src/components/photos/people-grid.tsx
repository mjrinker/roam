"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Person } from "@/lib/faces/service";

/** The people tagged in a photo library: a face and a name each, opening that person's pictures. The server's admin can rename or remove them. */
export function PeopleGrid({ serverId, libraryId, people, canEdit }: { serverId: string; libraryId: string; people: Person[]; canEdit: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function send(person: Person, init: RequestInit) {
    setBusy(person.id);
    setFailed(false);
    const res = await fetch(`/api/people/${person.id}`, { ...init, headers: { "content-type": "application/json" } }).catch(() => null);
    setBusy(null);
    if (!res || !res.ok) return setFailed(true);
    router.refresh();
  }

  if (people.length === 0) {
    return (
      <p className="rounded-xl bg-white/[0.04] px-4 py-6 text-sm text-muted-foreground ring-1 ring-white/10">
        No one has been named yet. Open a photo, choose Info, and say who is in it: matching faces in other photos are then suggested.
      </p>
    );
  }
  return (
    <div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {people.map((p) => (
          <li key={p.id} className="flex flex-col items-center gap-2 text-center">
            <Link href={`/s/${serverId}/library/${libraryId}?q=${encodeURIComponent(p.name)}`} className="group flex flex-col items-center gap-2">
              {p.coverFaceId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/faces/${p.coverFaceId}/thumb`} alt="" className="size-24 rounded-full object-cover ring-1 ring-white/15 transition group-hover:ring-2 group-hover:ring-primary" loading="lazy" />
              ) : (
                <span className="size-24 rounded-full bg-white/10" />
              )}
              <span className="text-sm font-medium">{p.name}</span>
              <span className="-mt-1.5 text-xs text-muted-foreground">{p.photos === 1 ? "1 photo" : `${p.photos} photos`}</span>
            </Link>
            {canEdit && (
              <span className="flex gap-1 text-xs text-muted-foreground">
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => {
                    const name = window.prompt("Rename this person. Using a name someone else has joins the two.", p.name);
                    if (name && name.trim() && name.trim() !== p.name) void send(p, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
                  }}
                  className="rounded-md px-1.5 py-0.5 hover:bg-white/10 hover:text-foreground"
                >
                  Rename
                </button>
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => {
                    if (window.confirm(`Remove ${p.name}? Their faces stay in the photos, unnamed.`)) void send(p, { method: "DELETE" });
                  }}
                  className="rounded-md px-1.5 py-0.5 hover:bg-white/10 hover:text-red-300"
                >
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {failed && <p role="alert" className="mt-4 text-sm text-red-300">Couldn&apos;t do that.</p>}
    </div>
  );
}
