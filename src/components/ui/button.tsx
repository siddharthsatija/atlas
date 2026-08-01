"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * Button — design system §9.
 *
 * Variants: primary, secondary, tertiary, destructive, icon, link.
 * Sizes: sm 32 / md 40 / lg 48.
 *
 * `destructive` is reserved for genuinely destructive operations and always pairs
 * with explicit confirmation copy — never a vague "OK" (design system §11).
 */
const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "rounded-input text-body-sm font-medium transition-colors",
    "duration-[--duration-standard] ease-[--ease-entrance]",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ),
  {
    variants: {
      variant: {
        primary: "bg-accent text-white hover:brightness-110 active:brightness-95",
        secondary:
          "bg-surface text-text-primary border border-border-default hover:bg-surface-subtle active:bg-surface-subtle",
        tertiary: "text-text-secondary hover:bg-surface-subtle hover:text-text-primary",
        destructive: "bg-danger text-white hover:brightness-110 active:brightness-95",
        icon: "text-text-secondary hover:bg-surface-subtle hover:text-text-primary",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3",
        md: "h-10 px-4",
        lg: "h-12 px-6 text-body",
        // 44x44 minimum target where practical (accessibility skill).
        iconSm: "size-8",
        iconMd: "size-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a spinner and disables interaction. Every variant supports this. */
  loading?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="size-4" />
          <span className="sr-only">Loading</span>
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
