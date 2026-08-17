"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Toast — confirms transient events only (frontend spec §19).
 *
 * A toast is never the sole signal for durable status: anything the user must be
 * able to find later also appears in the page. Follow-up reminders and request
 * status live in notifications and on the entity, not in a toast (ADR-005).
 *
 * Radix renders the viewport as an aria-live region, so status is announced.
 * Never place a personal value or draft text in a toast.
 */
const ToastProvider = ToastPrimitive.Provider;

/**
 * The viewport is a fixed strip pinned to the bottom of **every** page, mounted
 * once in `src/providers/index.tsx`.
 *
 * ## Why it must not receive pointer events
 *
 * It is `w-full` below `sm` (a toast spans a narrow screen) and its `p-4` gives
 * it a height even with nothing inside, so it covers a full-width band across the
 * bottom of the layout. Radix drops pointer events on its wrapper only while the
 * list is *empty* — the moment any toast opens, that whole band becomes
 * hit-testable, and a control near the bottom of the page stops being clickable
 * even though nothing visible is on top of it. Mobile Playwright found exactly
 * that: `toast-viewport intercepts pointer events` over "Save detail", where the
 * shorter viewport puts the form's submit inside the band.
 *
 * So the strip is transparent to the pointer at all times and each `Toast`
 * re-enables it for itself. Undo, dismiss and swipe still work because they are
 * on the toast; the gaps, the padding and the empty strip pass clicks through to
 * the page underneath.
 *
 * Keyboard access is untouched — `pointer-events` does not affect focus, the F8
 * hotkey, or Radix's tab handling on the viewport.
 */
function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed right-0 bottom-0 z-100 flex max-h-dvh w-full flex-col-reverse gap-2 p-4",
        "sm:top-auto sm:right-0 sm:bottom-0 sm:max-w-sm",
        className,
      )}
      {...props}
    />
  );
}

const toastVariants = cva(
  cn(
    // `pointer-events-auto` restores what the viewport gives up. A toast is the
    // only part of that strip a person can actually aim at, so it is the only part
    // that should intercept a click.
    "group border-border-default bg-surface-raised pointer-events-auto relative flex w-full items-start gap-3",
    "rounded-card border p-4 shadow-[--shadow-level-2]",
    "data-[state=open]:animate-in data-[state=closed]:animate-out",
    "data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0",
  ),
  {
    variants: {
      tone: {
        neutral: "",
        success: "border-success/30",
        // Warning/danger tones still require explanatory text; tone is not the message.
        warning: "border-warning/30",
        danger: "border-danger/30",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

interface ToastProps
  extends React.ComponentProps<typeof ToastPrimitive.Root>, VariantProps<typeof toastVariants> {}

function Toast({ className, tone, ...props }: ToastProps) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(toastVariants({ tone }), className)}
      {...props}
    />
  );
}

function ToastTitle({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("text-body-sm font-medium", className)}
      {...props}
    />
  );
}

function ToastDescription({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("text-body-sm text-text-secondary", className)}
      {...props}
    />
  );
}

/** Undo lives here: archive and dismissal prefer undo over confirmation. */
function ToastAction({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Action>) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        "shrink-0 rounded-control px-2 py-1 text-body-sm font-medium text-accent",
        "transition-colors duration-[--duration-standard] hover:bg-accent-subtle",
        className,
      )}
      {...props}
    />
  );
}

function ToastClose({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={cn(
        "ml-auto grid size-6 shrink-0 place-items-center text-text-muted hover:text-text-primary",
        "rounded-control transition-colors duration-[--duration-standard]",
        className,
      )}
      {...props}
    >
      <XIcon aria-hidden="true" className="size-3.5" />
      <span className="sr-only">Dismiss</span>
    </ToastPrimitive.Close>
  );
}

export {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastAction,
  ToastClose,
  toastVariants,
};
