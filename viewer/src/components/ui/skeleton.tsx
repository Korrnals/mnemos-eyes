import { cn } from "@/lib/utils";

/** Loading shimmer placeholder (architecture.md §7 loading convention). */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-elevated", className)}
      {...props}
    />
  );
}

export { Skeleton };
