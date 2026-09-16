import { cn } from "@/lib/utils";

/**
 * Empty / error / not-found state (architecture.md §7 error conventions).
 * TODO(T5): visual pass per design-system.md §8.1 (the "well" hero treatment).
 */
export interface EmptyStateProps {
  variant?: "empty" | "error";
  title: string;
  message?: string;
  className?: string;
}

export function EmptyState({
  variant = "empty",
  title,
  message,
  className,
}: EmptyStateProps) {
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md p-12 text-center",
        className,
      )}
    >
      <p
        className={
          variant === "error"
            ? "text-lg font-semibold text-error"
            : "text-lg font-semibold text-foreground-secondary"
        }
      >
        {title}
      </p>
      {message ? (
        <p className="max-w-prose text-sm text-foreground-secondary">{message}</p>
      ) : null}
    </div>
  );
}
