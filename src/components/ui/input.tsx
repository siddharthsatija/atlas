"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Input — design system §11.
 *
 * The visible <label> and any help or error text are supplied by the form field
 * wrapper that owns association (`aria-describedby`, `aria-invalid`). A placeholder
 * is never a label.
 *
 * Sensitive values are masked by default and revealed deliberately; that behavior
 * belongs to the SensitiveValue primitive (ATL-035), not here.
 */
export interface InputProps extends React.ComponentProps<"input"> {
  /** Renders the error state. Association is the form field's responsibility. */
  invalid?: boolean;
}

function Input({ className, type = "text", invalid, ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      aria-invalid={invalid || undefined}
      className={cn(
        "bg-surface text-text-primary placeholder:text-text-muted",
        "h-10 w-full rounded-input border border-border-default px-3",
        "text-body-sm transition-colors duration-[--duration-standard]",
        "hover:border-border-strong",
        "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:opacity-60",
        // Error state carries a border change plus the aria attribute — never color alone.
        "aria-[invalid=true]:border-danger aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
