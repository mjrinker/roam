"use client";

import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { MAX_READER_BYTES } from "@/lib/ebooks/reader";

/**
 * Opens a PDF in a new tab. Box serves files as downloads, so the file is fetched straight from Box (a short-lived
 * address, allowed from any origin) and shown from a local blob URL, where the browser's own PDF viewer takes over.
 * The tab is opened first, on the click itself, so pop-up blockers allow it.
 */
export function PdfOpenButton({ titleId, sizeBytes }: { titleId: string; sizeBytes: number | null }) {
  const [busy, setBusy] = useState(false);

  async function open() {
    if (sizeBytes !== null && sizeBytes > MAX_READER_BYTES) return toast.error("This PDF is too large to open here. Use Download.");
    setBusy(true);
    const tab = window.open("", "_blank");
    try {
      const urlRes = await fetch(`/api/ebooks/${titleId}/url`, { cache: "no-store" });
      if (!urlRes.ok) throw new Error("This PDF isn't available.");
      const { url } = (await urlRes.json()) as { url: string };
      const file = await fetch(url);
      if (!file.ok) throw new Error("Couldn't load the PDF from Box.");
      const blob = new Blob([await file.arrayBuffer()], { type: "application/pdf" });
      const href = URL.createObjectURL(blob);
      if (tab) tab.location.href = href;
      else window.location.href = href;
      setTimeout(() => URL.revokeObjectURL(href), 10 * 60_000);
    } catch (err) {
      tab?.close();
      toast.error(err instanceof Error ? err.message : "Couldn't open this PDF.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={busy}
      className="inline-flex h-12 items-center gap-2.5 rounded-xl bg-primary px-8 text-base font-semibold text-primary-foreground shadow-[0_10px_34px_-8px_oklch(0.853_0.163_169/0.7)] transition hover:opacity-90 disabled:opacity-60"
    >
      {busy ? <Loader2 className="size-5 animate-spin" /> : <FileText className="size-5" />} Open PDF
    </button>
  );
}
