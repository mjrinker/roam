import { Skeleton } from "@/components/ui/skeleton";

export default function TitleLoading() {
  return (
    <div className="flex flex-col items-center gap-8 px-4 pt-14 pb-10 sm:px-8 md:flex-row md:items-end md:gap-10 md:pt-24">
      <Skeleton className="aspect-[2/3] w-44 shrink-0 rounded-2xl sm:w-52 md:w-60" />
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-36 rounded-xl" />
      </div>
    </div>
  );
}
