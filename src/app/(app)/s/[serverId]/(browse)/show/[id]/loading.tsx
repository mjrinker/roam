import { Skeleton } from "@/components/ui/skeleton";

export default function ShowLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col items-center gap-8 px-4 pt-14 pb-6 sm:px-8 md:flex-row md:items-end md:gap-10 md:pt-24">
        <Skeleton className="aspect-[2/3] w-44 shrink-0 rounded-2xl sm:w-52 md:w-60" />
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <Skeleton className="h-12 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
      <div className="flex flex-col gap-4 px-4 pb-12 sm:px-8">
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex gap-5 p-2.5">
            <Skeleton className="aspect-video w-36 shrink-0 rounded-lg sm:w-56" />
            <div className="flex-1 space-y-2 pt-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
