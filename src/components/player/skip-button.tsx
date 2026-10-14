import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { SkipButtonState } from "@/lib/skipdb/active";

/**
 * The "Skip intro" / "Skip recap" / "Next episode" button over the corner of the picture, with SkipDB's credit when its times are behind it
 * (their data licence asks for it).
 */
export function SkipButton({ state, nextHref, onSeek }: { state: SkipButtonState; nextHref?: string; onSeek: (seconds: number) => void }) {
  const className = "h-11 rounded-md bg-white px-5 text-base font-semibold text-black shadow-lg hover:bg-white/90";
  return (
    <div className="absolute right-4 bottom-28 z-20 flex flex-col items-end gap-1 sm:right-6 sm:bottom-32">
      {state.action === "next" && nextHref ? (
        <Button render={<Link href={nextHref} />} className={className}>
          {state.label}
        </Button>
      ) : (
        <Button type="button" onClick={() => onSeek(state.toSeconds ?? 0)} className={className}>
          {state.label}
        </Button>
      )}
      {state.fromSkipdb && (
        <a href="https://skipdb.tv" target="_blank" rel="noopener noreferrer" className="text-[10px] text-white/70 underline-offset-2 hover:underline">
          Skip times from SkipDB
        </a>
      )}
    </div>
  );
}
