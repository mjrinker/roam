import { useId } from "react";
import { LOGO_LETTERS, LOGO_VIEWBOX } from "@/components/shell/brand";

// Runs before first paint so a returning visitor never sees the splash flash.
// Shown once per browser tab session, and never with reduced motion.
export const SPLASH_SKIP_SCRIPT = `try{var d=document.documentElement;if(sessionStorage.getItem("roam-splash")||matchMedia("(prefers-reduced-motion: reduce)").matches){d.dataset.splash="skip"}else{sessionStorage.setItem("roam-splash","1")}}catch(e){}`;

// Where each letter flies in from (SVG user units), in R-O-A-M order.
const LETTER_FROM = [
  "translateX(-220px)",
  "scale(0.15)",
  "translateY(180px)",
  "translateY(-180px)",
] as const;

/** Full-screen logo intro. Pure CSS (see .splash in globals.css): it fades itself out, no client JS needed. */
export function SplashScreen() {
  const id = useId();
  const gradientId = `${id}-g`;
  const sheenId = `${id}-s`;
  const clipId = `${id}-c`;

  return (
    <div className="splash" aria-hidden="true">
      <div className="splash-glow" />
      <svg viewBox={LOGO_VIEWBOX} className="splash-logo">
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
          <linearGradient id={sheenId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.7" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={clipId}>
            {LOGO_LETTERS.map((d) => (
              <path key={d} d={d} />
            ))}
          </clipPath>
        </defs>

        <g fill={`url(#${gradientId})`}>
          {LOGO_LETTERS.map((d, i) => (
            <path
              key={d}
              d={d}
              className="splash-letter"
              style={{ "--i": i, "--from": LETTER_FROM[i] } as React.CSSProperties}
            />
          ))}
        </g>

        <g clipPath={`url(#${clipId})`}>
          <rect
            className="splash-sheen"
            x="-400"
            y="480"
            width="380"
            height="480"
            fill={`url(#${sheenId})`}
          />
        </g>
      </svg>
    </div>
  );
}
