"use client";

import { useState } from "react";
import { PhotoTile, type PhotoTileData } from "@/components/photos/photo-tile";
import { ScreenshotBar } from "@/components/photos/screenshot-bar";
import type { ScreenshotFilter } from "@/lib/photos/screenshot-filter";
import { SelectToggle } from "@/components/photos/select-toggle";

/** An album's pictures, with (for the admin) a Select mode to mark several as screenshots at once. */
export function SelectablePhotoGrid({ serverId, items, from, canMark, screenshots }: { serverId: string; items: PhotoTileData[]; from: string; canMark: boolean; screenshots: ScreenshotFilter }) {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const stop = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  return (
    <div className="flex flex-col gap-3">
      {canMark && <SelectToggle selecting={selecting} onChange={(on) => (on ? setSelecting(true) : stop())} />}
      <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((item, i) => (
          <li key={item.id} className="min-w-0">
            <PhotoTile serverId={serverId} item={item} from={from} priority={i < 12} selecting={selecting} selected={picked.has(item.id)} onToggle={toggle} />
          </li>
        ))}
      </ul>
      {selecting && (
        <ScreenshotBar
          serverId={serverId}
          ids={[...picked]}
          onCancel={stop}
          onDone={() => {
            // Hidden (or only-shown) screenshots change what the page lists, so it is loaded afresh.
            if (screenshots !== "show") window.location.reload();
            else stop();
          }}
        />
      )}
    </div>
  );
}
