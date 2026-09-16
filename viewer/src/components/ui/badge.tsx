import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
  {
    variants: {
      variant: {
        default: "border-transparent bg-elevated text-foreground-secondary",
        iris: "border-transparent bg-iris-dim text-iris-bright",
        confidence: "border-transparent bg-confidence-dim text-confidence",
        outline: "border-border text-foreground-secondary",
        success: "border-transparent bg-success/15 text-success",
        error: "border-transparent bg-error/15 text-error",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
