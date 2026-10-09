"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Loader2, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SUBTITLE_LANGUAGES } from "@/lib/subtitles/languages";
import type { SubtitleResult } from "@/lib/subtitles/opensubtitles";
import type { TrackInfo } from "@/lib/subtitles/service";

const field = "h-10 rounded-lg border border-input bg-transparent px-3 text-sm";

function LanguageSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={field}>
      {SUBTITLE_LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : fallback;
}

/** Manage one movie's or episode's subtitles: what it has, search OpenSubtitles, upload a file. */
export function SubtitleManager({ ownerKind, ownerId, tracks, openSubtitlesReady, defaultLanguage, watchHref }: { ownerKind: "title" | "episode"; ownerId: string; tracks: TrackInfo[]; openSubtitlesReady: boolean; defaultLanguage: string; watchHref: string }) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const refresh = () => startRefresh(() => router.refresh());

  const [removing, setRemoving] = useState<string | null>(null);
  async function remove(track: TrackInfo) {
    if (!window.confirm(`Remove "${track.label}"?`)) return;
    setRemoving(track.id);
    const res = await fetch(`/api/subtitles/${track.id}`, { method: "DELETE" });
    setRemoving(null);
    if (!res.ok) return void toast.error(await errorOf(res, "Couldn't remove it."));
    toast.success("Removed.");
    refresh();
  }

  const [searchLanguage, setSearchLanguage] = useState(defaultLanguage);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SubtitleResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  async function search(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    setSearchError(null);
    const res = await fetch(`/api/subtitles/search?ownerKind=${ownerKind}&ownerId=${ownerId}&languages=${encodeURIComponent(searchLanguage)}`);
    setSearching(false);
    if (!res.ok) {
      setResults(null);
      setSearchError(await errorOf(res, "The search failed."));
      return;
    }
    setResults((await res.json()).results as SubtitleResult[]);
  }
  async function addResult(r: SubtitleResult) {
    setAdding(r.fileId);
    const res = await fetch("/api/subtitles/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKind, ownerId, fileId: r.fileId, language: r.language, hearingImpaired: r.hearingImpaired }) });
    setAdding(null);
    if (!res.ok) return void toast.error(await errorOf(res, "Couldn't add it."));
    const body = await res.json();
    toast.success(body.remaining !== null && body.remaining !== undefined ? `Added. ${body.remaining} downloads left today.` : "Added.");
    refresh();
  }

  const [uploadLanguage, setUploadLanguage] = useState(defaultLanguage);
  const [label, setLabel] = useState("");
  const [sdh, setSdh] = useState(false);
  const [uploading, setUploading] = useState(false);
  async function uploadFile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return void toast.error("Choose a subtitle file first.");
    const body = new FormData();
    body.set("ownerKind", ownerKind);
    body.set("ownerId", ownerId);
    body.set("language", uploadLanguage);
    body.set("label", label);
    body.set("hearingImpaired", String(sdh));
    body.set("file", file);
    setUploading(true);
    const res = await fetch("/api/subtitles", { method: "POST", body });
    setUploading(false);
    if (!res.ok) return void toast.error(await errorOf(res, "Couldn't add that file."));
    toast.success("Subtitles added.");
    setLabel("");
    setSdh(false);
    input.value = "";
    refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="have" className="flex flex-col gap-3">
        <h2 id="have" className="text-lg font-semibold">On this video</h2>
        {tracks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subtitles yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tracks.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/[0.08]">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {t.language} · {t.cueCount.toLocaleString()} lines · {t.source === "upload" ? "your file" : "OpenSubtitles"}
                    {t.hearingImpaired ? " · for the hard of hearing" : ""}
                  </p>
                </div>
                <Button variant="ghost" size="icon" aria-label={`Remove ${t.label}`} disabled={removing === t.id} onClick={() => remove(t)}>
                  {removing === t.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button render={<Link href={watchHref} />} variant="secondary" className="rounded-xl">
            Back to the player
          </Button>
        </div>
      </section>

      <section aria-labelledby="find" className="flex flex-col gap-3">
        <h2 id="find" className="text-lg font-semibold">Find on OpenSubtitles</h2>
        {!openSubtitlesReady ? (
          <p className="text-sm text-muted-foreground">OpenSubtitles isn&apos;t set up on this server yet (see the README). You can still add a file of your own below.</p>
        ) : (
          <>
            <form onSubmit={search} className="flex flex-wrap items-center gap-2">
              <LanguageSelect value={searchLanguage} onChange={setSearchLanguage} label="Language to search for" />
              <Button type="submit" disabled={searching} className="gap-2 rounded-xl">
                {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Search
              </Button>
            </form>
            {searchError && <p role="alert" className="text-sm text-destructive">{searchError}</p>}
            {results && results.length === 0 && <p className="text-sm text-muted-foreground">Nothing found in that language.</p>}
            {results && results.length > 0 && (
              <ul className="flex flex-col gap-2">
                {results.map((r) => (
                  <li key={r.fileId} className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/[0.08]">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.release || r.fileName || "Subtitle"}</p>
                      <p className="text-xs text-muted-foreground">
                        {r.language} · {r.downloads.toLocaleString()} downloads
                        {r.trusted ? " · trusted uploader" : ""}
                        {r.hearingImpaired ? " · for the hard of hearing" : ""}
                        {r.aiTranslated ? " · machine translated" : ""}
                      </p>
                    </div>
                    <Button size="sm" variant="secondary" className="gap-2 rounded-lg" disabled={adding !== null} onClick={() => addResult(r)}>
                      {adding === r.fileId ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Add
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">Each one added uses one of the account&apos;s daily OpenSubtitles downloads.</p>
          </>
        )}
      </section>

      <section aria-labelledby="own" className="flex flex-col gap-3">
        <h2 id="own" className="text-lg font-semibold">Add a file of your own</h2>
        <form onSubmit={uploadFile} className="flex flex-col gap-3 rounded-xl bg-white/[0.04] p-4 ring-1 ring-white/[0.08]">
          <input name="file" type="file" accept=".srt,.vtt,.ass,.ssa,text/plain,text/vtt" aria-label="Subtitle file" className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-sm" />
          <div className="flex flex-wrap items-center gap-2">
            <LanguageSelect value={uploadLanguage} onChange={setUploadLanguage} label="Language of the file" />
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" aria-label="Name for these subtitles" maxLength={60} className="h-10 w-56" />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={sdh} onChange={(e) => setSdh(e.target.checked)} className="size-4 accent-[var(--primary)]" /> For the hard of hearing
            </label>
          </div>
          <div>
            <Button type="submit" disabled={uploading} className="gap-2 rounded-xl">
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Add subtitles
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">SRT, WebVTT or ASS, up to 2 MB. Only the words and their timing are kept.</p>
        </form>
      </section>
    </div>
  );
}
