import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Text input. The "pupil" oval treatment (radius-xl, iris focus glow) is a
 * SearchBar-level composition (TODO T5); this stays a plain token-bound field.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-well px-3 py-1 text-base transition-colors duration-instant",
        "placeholder:text-foreground-muted",
        "focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
