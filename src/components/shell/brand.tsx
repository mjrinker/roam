import { cn } from "@/lib/utils";

/** The Roam mark: a gold rounded tile with a stylised play-triangle orbiting ring. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative inline-flex size-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-[oklch(0.86_0.15_85)] to-[oklch(0.7_0.16_65)] shadow-[0_4px_18px_-4px_oklch(0.79_0.16_78/0.6)]",
        className
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="size-[55%] text-[oklch(0.2_0.03_70)]" fill="currentColor">
        <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
      </svg>
    </span>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-lg font-semibold tracking-tight", className)}>Roam</span>
  );
}
