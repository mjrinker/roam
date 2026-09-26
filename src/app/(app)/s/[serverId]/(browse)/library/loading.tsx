import { Skeleton } from "@/components/ui/skeleton";

export default function HomeLoading() {
  return (
    <div className="flex flex-col gap-10 pb-16">
      <Skeleton className="-mt-16 h-[440px] w-full rounded-none sm:h-[500px] lg:h-[560px]" />
      <section className="flex flex-col gap-3 px-4 sm:px-8">
        <Skeleton className="h-6 w-44" />
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex w-36 shrink-0 flex-col gap-2.5 sm:w-44">
              <Skeleton className="aspect-[2/3] w-full rounded-xl" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
