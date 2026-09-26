import { Loader2 } from "lucide-react";

export default function WatchLoading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-black">
      <Loader2 className="size-10 animate-spin text-white/60" />
    </div>
  );
}
