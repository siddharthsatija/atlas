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

function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "fixed right-0 bottom-0 z-100 flex max-h-dvh w-full flex-col-reverse gap-2 p-4",
        "sm:top-auto sm:right-0 sm:bottom-0 sm:max-w-sm",
        className,
      )}
      {...props}
    />
  );
}

const toastVariants = cva(
  cn(
    "group border-border-default bg-surface-raised relative flex w-full items-start gap-3",
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
