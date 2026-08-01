"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * Input — design system §11, states per frontend §18.
 *
 * The resting border uses **`border-strong`**, not `border-default`: an input's
 * border is the visual affordance that identifies the control, so it must meet the
 * 3:1 non-text contrast requirement (SC 1.4.11). `border-default` is decorative
 * separation only and does not (design system §2.4, established by ATL-008).
 *
 * The visible `<label>`, help text, and error text are supplied by the form field
 * wrapper that owns their association (`aria-describedby`, `aria-invalid`). A
 * placeholder is never a label.
 *
 * Masking of sensitive values is NOT this component's job — that is
 * `SensitiveValue`, which handles deliberate temporary reveal and the audit seam.
 */

export type InputState = "default" | "error" | "success";

export interface InputProps extends Omit<React.ComponentProps<"input">, "size"> {
  /** Validation state. `error` also sets `aria-invalid`. */
  state?: InputState;
  /**
   * Async work in progress (e.g. availability check). Renders a spinner and marks
   * the field busy without removing it from the tab order.
   */
  loading?: boolean;
}

function Input({
  className,
  type = "text",
  state = "default",
  loading = false,
  ...props
}: InputProps) {
  const field = (
    <input
      type={type}
      data-slot="input"
      data-state={state}
      aria-invalid={state === "error" ? true : undefined}
      aria-busy={loading || undefined}
      className={cn(
        "bg-surface text-text-primary placeholder:text-text-muted",
        // border-strong: the control's identifying boundary (SC 1.4.11).
        "h-10 w-full rounded-input border border-border-strong px-3",
        "text-body-sm transition-colors duration-[--duration-standard]",
        // hover / focus
        "hover:border-accent",
        // disabled + read-only
        "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:opacity-60",
        "read-only:cursor-default read-only:bg-surface-subtle",
        // error / success — never colour alone: the form field renders the message,
        // and aria-invalid carries the state programmatically.
        "data-[state=error]:border-danger data-[state=error]:ring-2 data-[state=error]:ring-danger/20",
        "data-[state=success]:border-success",
        loading && "pr-9",
        className,
      )}
      {...props}
    />
  );

  if (!loading) return field;

  return (
    <span data-slot="input-wrapper" className="relative block">
      {field}
      <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-muted" />
      <span className="sr-only" role="status" aria-live="polite">
        Checking…
      </span>
    </span>
  );
}

export { Input };
