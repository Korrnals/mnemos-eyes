import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import "./skeletons.css";

/**
 * Skeleton variants (component-inventory §11). All use `--color-bg-elevated`
 * with a subtle shimmer keyframe that disables at `prefers-reduced-motion`
 * (see skeletons.css). `GraphSkeleton` arrives with the L2 cluster slot.
 */

export interface MemoryCardSkeletonProps {
  /** How many cards to render. */
  count?: number;
  className?: string;
}

/** Used by MemoryListPage and SearchResultList. */
export function MemoryCardSkeleton({ count = 3, className }: MemoryCardSkeletonProps) {
  return (
    <div aria-hidden="true" className={cn("grid gap-4", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="shimmer rounded-md border border-border-subtle bg-well p-6">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="mt-2 h-3 w-1/3" />
          <Skeleton className="mt-4 h-3 w-full" />
          <Skeleton className="mt-1 h-3 w-5/6" />
          <div className="mt-4 flex gap-1">
            <Skeleton className="h-5 w-20 rounded-sm" />
            <Skeleton className="h-5 w-24 rounded-sm" />
            <Skeleton className="h-5 w-16 rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Used by MemoryDetailPage — the scroll placeholder. */
export function MemoryScrollSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("space-y-4", className)}>
      <div className="shimmer rounded-lg border border-scroll-border bg-scroll-bg p-8">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="mt-6 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-11/12" />
        <Skeleton className="mt-2 h-3 w-4/5" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </div>
      <Skeleton className="h-4 w-48" />
    </div>
  );
}

/** Used by StatusPage. */
export function StatGridSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="shimmer rounded-md border border-border-subtle bg-well p-6">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Used by TracesPage and SessionsPage (table rows). */
export function TableRowSkeleton({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={cn("space-y-2", className)}>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="shimmer flex items-center gap-4 rounded-md border border-border-subtle bg-well px-4 py-3">
          {Array.from({ length: columns }, (_, colIndex) => (
            <Skeleton
              key={colIndex}
              className={cn("h-4", colIndex === 0 ? "w-1/4" : "flex-1")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
