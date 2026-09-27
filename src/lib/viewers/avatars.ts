import { Cat, Rocket, Smile, User, type LucideIcon } from "lucide-react";

// The built-in avatar gallery: a glyph on a gradient. Profiles store only the
// key, so there is nothing to upload, host, or moderate. Gradient classes are
// written out in full so Tailwind sees them.

export interface AvatarPreset {
  key: string;
  label: string;
  icon: LucideIcon;
  gradient: string;
}

const COLORS = [
  { id: "teal", label: "Teal", gradient: "from-teal-300 to-cyan-600" },
  { id: "violet", label: "Violet", gradient: "from-violet-400 to-fuchsia-600" },
  { id: "amber", label: "Amber", gradient: "from-amber-300 to-orange-600" },
  { id: "rose", label: "Rose", gradient: "from-rose-400 to-pink-600" },
  { id: "sky", label: "Sky", gradient: "from-sky-400 to-blue-600" },
  { id: "lime", label: "Lime", gradient: "from-lime-300 to-emerald-600" },
] as const;

const GLYPHS = [
  { id: "user", label: "Person", icon: User },
  { id: "smile", label: "Smile", icon: Smile },
  { id: "cat", label: "Cat", icon: Cat },
  { id: "rocket", label: "Rocket", icon: Rocket },
] as const;

export const AVATARS: AvatarPreset[] = COLORS.flatMap((c) =>
  GLYPHS.map((g) => ({
    key: `${c.id}-${g.id}`,
    label: `${c.label} ${g.label.toLowerCase()}`,
    icon: g.icon,
    gradient: c.gradient,
  }))
);

export const DEFAULT_AVATAR_KEY = "teal-user";

const BY_KEY = new Map(AVATARS.map((a) => [a.key, a]));

export function isAvatarKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** The preset for a key, falling back to the default so a stale key can never break rendering. */
export function getAvatar(key: string | null | undefined): AvatarPreset {
  return (key ? BY_KEY.get(key) : undefined) ?? (BY_KEY.get(DEFAULT_AVATAR_KEY) as AvatarPreset);
}

