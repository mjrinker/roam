"use client";

import { useRouter } from "next/navigation";
import { PhotoViewer } from "@/components/photos/photo-viewer";
import type { ViewerItem } from "@/lib/photos/viewer-item";

/**
 * The viewer on its own page (a link someone opened directly, or from an album): stepping and closing
 * navigate to the neighbouring page. From the timeline the viewer is an overlay instead (see photo-timeline),
 * which is why that feels instant and this one can't.
 */
export function PhotoPageViewer({
  current,
  prev,
  next,
  prevHref,
  nextHref,
  backHref,
  libraryId,
  words,
}: {
  current: ViewerItem;
  prev: ViewerItem | null;
  next: ViewerItem | null;
  prevHref: string | null;
  nextHref: string | null;
  backHref: string;
  libraryId: string;
  words: { add: string; remove: string };
}) {
  const router = useRouter();
  return (
    <PhotoViewer
      current={current}
      prev={prev}
      next={next}
      libraryId={libraryId}
      words={words}
      onPrev={() => prevHref && router.push(prevHref)}
      onNext={() => nextHref && router.push(nextHref)}
      onClose={() => router.push(backHref)}
    />
  );
}
