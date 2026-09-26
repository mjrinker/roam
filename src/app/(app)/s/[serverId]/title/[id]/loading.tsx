import { Skeleton } from "@/components/ui/skeleton";

export default function TitleLoading() {
  return (
    <div className="flex flex-col gap-6 px-6 py-10 sm:flex-row">
      <Skeleton className="h-72 w-48 shrink-0 rounded-md sm:h-96 sm:w-64" />
      <div className="flex max-w-2xl flex-1 flex-col gap-4">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-9 w-28" />
      </div>
    </div>
  );
}
