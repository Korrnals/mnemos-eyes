import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Unified no-data / error / not-found / offline visual (component-inventory
 * §11, architecture.md §7). Used by route-level error boundaries and empty
 * results. The iris is dimmed per variant: muted on `empty`, error-tinted on
 * `error`/`not-found`.
 */
export interface EmptyStateProps {
  variant?: "empty" | "error" | "not-found" | "offline";
  /** Primary message. */
  title: string;
  /** Secondary line. */
  message?: string;
  /** Tertiary detail line (component-inventory §11: `detail`). */
  detail?: string;
  /** CTA slot, e.g. a Retry button. */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  variant = "empty",
  title,
  message,
  detail,
  action,
  className,
}: EmptyStateProps) {
  const t = useT();
  const isErrorLike = variant === "error" || variant === "not-found";
  return (
    <div
      role={isErrorLike ? "alert" : "status"}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md p-12 text-center",
        className,
      )}
    >
      <IrisLogo
        size={64}
        decorative
        className={cn(
          "shrink-0",
          isErrorLike ? "opacity-70 saturate-50" : "opacity-40 grayscale",
        )}
      />
      <p
        className={cn(
          "text-lg font-semibold",
          isErrorLike ? "text-error" : "text-foreground-secondary",
        )}
      >
        {title}
      </p>
      {message ? (
        <p className="max-w-prose text-sm text-foreground-secondary">{message}</p>
      ) : null}
      {detail ? (
        <p className="max-w-prose text-xs text-foreground-muted">{detail}</p>
      ) : null}
      {variant === "offline" ? (
        <p className="max-w-prose text-xs text-foreground-muted">
          {t("empty.offlineNote")}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
