"use client";

import { cn } from "@/lib/utils";
import { AVATARS } from "@/lib/viewers/avatars";
import { ViewerAvatar } from "@/components/profiles/viewer-avatar";

export function AvatarPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Avatar" className="grid grid-cols-6 gap-2">
      {AVATARS.map((a) => (
        <button
          key={a.key}
          type="button"
          role="radio"
          aria-checked={value === a.key}
          aria-label={a.label}
          title={a.label}
          onClick={() => onChange(a.key)}
          className={cn(
            "flex items-center justify-center rounded-full p-0.5 outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
            value === a.key ? "ring-2 ring-primary" : "opacity-80 hover:opacity-100"
          )}
        >
          <ViewerAvatar avatarKey={a.key} size="md" />
        </button>
      ))}
    </div>
  );
}
