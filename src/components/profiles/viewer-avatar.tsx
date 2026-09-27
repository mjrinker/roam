import { cn } from "@/lib/utils";
import { getAvatar } from "@/lib/viewers/avatars";

const SIZES = {
  xs: { box: "size-7", icon: "size-4" },
  sm: { box: "size-9", icon: "size-5" },
  md: { box: "size-11", icon: "size-6" },
  lg: { box: "size-16", icon: "size-9" },
  xl: { box: "size-28 sm:size-32", icon: "size-14 sm:size-16" },
} as const;

/** A profile's avatar: a glyph on a gradient, from the built-in gallery. */
export function ViewerAvatar({
  avatarKey,
  size = "md",
  className,
}: {
  avatarKey: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const avatar = getAvatar(avatarKey);
  const Icon = avatar.icon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-black/70 shadow-inner ring-1 ring-white/15",
        avatar.gradient,
        SIZES[size].box,
        className
      )}
    >
      <Icon className={SIZES[size].icon} strokeWidth={1.75} />
    </span>
  );
}
