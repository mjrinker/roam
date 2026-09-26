import { Skeleton } from "@/components/ui/skeleton";

export default function ShowLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6 px-6 py-10 sm:flex-row">
        <Skeleton className="h-72 w-48 shrink-0 rounded-md sm:h-96 sm:w-64" />
        <div className="flex max-w-2xl flex-1 flex-col gap-4">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
      <div className="flex flex-col gap-3 px-6 pb-12">
        <Skeleton className="h-6 w-32" />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 py-3">
            <Skeleton className="h-16 w-28 shrink-0 rounded" />
            <div className="flex-1">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-2 h-3 w-1/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
