import { useId } from "react";
import { cn } from "@/lib/utils";

const LOGO_PATH =
  "M139 505H330C390 505 435 562 435 632C435 700 388 755 328 759L483 938H139Z M484 721.5a216 216 0 1 0 432 0a216 216 0 1 0-432 0Z M1153 505L1400 938H907Z M1450 505L1665 721L1881 505V938H1450Z";

const VARIANT_CLASS = {
  gradient: "",
  teal: "text-primary",
  muted: "text-muted-foreground",
} as const;

/** The ROAM wordmark. Use "gradient" where it's large, "teal" or "muted" where it's small. */
export function BrandLogo({
  variant = "teal",
  className,
}: {
  variant?: keyof typeof VARIANT_CLASS;
  className?: string;
}) {
  const gradientId = useId();
  return (
    <svg
      viewBox="139 505 1742 433"
      role="img"
      aria-label="Roam"
      className={cn("h-6 w-auto shrink-0", VARIANT_CLASS[variant], className)}
    >
      {variant === "gradient" && (
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="139"
            y1="505"
            x2="1881"
            y2="938"
          >
            <stop offset="0" stopColor="#8bf9e0" />
            <stop offset="0.5" stopColor="#2ef0bc" />
            <stop offset="1" stopColor="#1fb5cc" />
          </linearGradient>
        </defs>
      )}
      <path
        fill={variant === "gradient" ? `url(#${gradientId})` : "currentColor"}
        d={LOGO_PATH}
      />
    </svg>
  );
}
