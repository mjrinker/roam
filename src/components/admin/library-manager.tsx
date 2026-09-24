"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface LastScanInfo {
  trigger: "manual" | "cron" | "webhook";
  finishedAt: string | null;
  filesSeen: number;
  titlesAdded: number;
  errors: string[];
}

export interface LibraryRow {
  id: string;
  name: string;
  kind: "movies" | "shows";
  boxFolderId: string;
  lastScannedAt: string | null;
  lastScan: LastScanInfo | null;
}

const ERRORS_SHOWN = 10;

function ScanErrors({ errors }: { errors: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (errors.length === 0) return null;

  const shown = expanded ? errors : errors.slice(0, ERRORS_SHOWN);
  return (
    <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="text-xs font-medium text-destructive">
        Last scan had {errors.length} error{errors.length === 1 ? "" : "s"}:
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {shown.map((err, i) => (
          <li key={i} className="text-xs text-destructive/90">
            {err}
          </li>
        ))}
      </ul>
      {errors.length > ERRORS_SHOWN && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-xs underline text-destructive/90"
        >
          {expanded ? "Show fewer" : `Show ${errors.length - ERRORS_SHOWN} more`}
        </button>
      )}
    </div>
  );
}

export function LibraryManager({ libraries }: { libraries: LibraryRow[] }) {
  const router = useRouter();
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(libraries.length === 0);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"movies" | "shows">("movies");
  const [boxFolderId, setBoxFolderId] = useState("");
  const [isPending, startTransition] = useTransition();

  async function createLibrary(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/libraries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, kind, boxFolderId }),
    });
    if (!res.ok) {
      toast.error("Couldn't create library.");
      return;
    }
    toast.success(`Library "${name}" created.`);
    setName("");
    setBoxFolderId("");
    setShowForm(false);
    startTransition(() => router.refresh());
  }

  async function rescan(libraryId: string) {
    setScanningId(libraryId);
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryId }),
    });
    setScanningId(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Scan failed to start.");
      return;
    }
    const body = await res.json();
    const result = body.results?.[0];
    if (result?.errors?.length) {
      toast.warning(`Scan finished with ${result.errors.length} error(s) — see details below.`);
    } else {
      toast.success(`Scan complete — ${result?.titlesAdded ?? 0} new title(s).`);
    }
    startTransition(() => router.refresh());
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Libraries</h2>
        <Button variant="outline" size="sm" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "Add library"}
        </Button>
      </div>

      {showForm && (
        <Card>
          <form onSubmit={createLibrary}>
            <CardHeader>
              <CardTitle className="text-base">New library</CardTitle>
              <CardDescription>
                Points at a root folder in your Box account. Right-click the folder
                in Box and copy the ID from its URL.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lib-name">Name</Label>
                <Input
                  id="lib-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Movies"
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lib-kind">Kind</Label>
                <select
                  id="lib-kind"
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "movies" | "shows")}
                >
                  <option value="movies">Movies</option>
                  <option value="shows">TV Shows</option>
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lib-folder">Box folder ID</Label>
                <Input
                  id="lib-folder"
                  value={boxFolderId}
                  onChange={(e) => setBoxFolderId(e.target.value)}
                  placeholder="123456789"
                  required
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" disabled={isPending}>
                Create library
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {libraries.map((lib) => (
          <Card key={lib.id}>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{lib.name}</p>
                    <Badge variant="secondary">{lib.kind}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Box folder {lib.boxFolderId} &middot; last scanned{" "}
                    {lib.lastScannedAt
                      ? new Date(lib.lastScannedAt).toLocaleString()
                      : "never"}
                    {lib.lastScan && (
                      <>
                        {" "}
                        ({lib.lastScan.trigger}) &middot; {lib.lastScan.filesSeen} folder(s)
                        seen, {lib.lastScan.titlesAdded} new
                      </>
                    )}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={scanningId === lib.id}
                  onClick={() => rescan(lib.id)}
                >
                  {scanningId === lib.id ? "Scanning…" : "Rescan"}
                </Button>
              </div>
              {lib.lastScan && <ScanErrors errors={lib.lastScan.errors} />}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
