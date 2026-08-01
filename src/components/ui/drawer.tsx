"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Drawer — edge-anchored panel (ATL-009).
 *
 * Built on Radix Dialog, which supplies the behavior the ticket requires: focus
 * trap, Escape to close, focus return to the trigger, and inert background.
 * Reimplementing those by hand is how subtle keyboard traps appear.
 *
 * Drawer vs Dialog (frontend §19): a Dialog is for a focused, contained task; a
 * Drawer supports contextual inspection alongside the page, and is what the
 * sidebar becomes on mobile (frontend §2 — that usage lands in ATL-007).
 *
 * Consumers with unsaved work must guard `onOpenChange`; the primitive cannot know
 * whether closing would discard something.
 */

const drawerVariants = cva(
  cn(
    "bg-surface-raised border-border-default fixed z-50 flex flex-col gap-4 p-6",
    "shadow-[--shadow-level-3]",
    "data-[state=open]:animate-in data-[state=closed]:animate-out",
  ),
  {
    variants: {
      side: {
        left: cn(
          "inset-y-0 left-0 h-full w-80 max-w-[85vw] border-r",
          "data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        ),
        right: cn(
          "inset-y-0 right-0 h-full w-80 max-w-[85vw] border-l",
          "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
        ),
        bottom: cn(
          "inset-x-0 bottom-0 max-h-[85dvh] w-full rounded-t-modal border-t",
          "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
        ),
      },
    },
    defaultVariants: { side: "right" },
  },
);

const Drawer = DialogPrimitive.Root;
const DrawerTrigger = DialogPrimitive.Trigger;
const DrawerPortal = DialogPrimitive.Portal;
const DrawerClose = DialogPrimitive.Close;

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-scrim/50 backdrop-blur-[1px]",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

interface DrawerContentProps
  extends
    React.ComponentProps<typeof DialogPrimitive.Content>,
    VariantProps<typeof drawerVariants> {
  showCloseButton?: boolean;
}

function DrawerContent({
  className,
  children,
  side,
  showCloseButton = true,
  ...props
}: DrawerContentProps) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DialogPrimitive.Content
        data-slot="drawer-content"
        className={cn(drawerVariants({ side }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="drawer-close"
            className={cn(
              "text-text-secondary hover:bg-surface-subtle hover:text-text-primary",
              "absolute top-4 right-4 grid size-8 place-items-center rounded-control",
              "transition-colors duration-[--duration-standard]",
            )}
          >
            <XIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex flex-col gap-1 pr-8", className)}
      {...props}
    />
  );
}

/** Provides the drawer's accessible name. Every drawer must render one. */
function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-h3 font-semibold", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-body-sm text-text-secondary", className)}
      {...props}
    />
  );
}

function DrawerBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-body"
      className={cn("min-h-0 grow overflow-y-auto", className)}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerTrigger,
  DrawerPortal,
  DrawerClose,
  DrawerOverlay,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerBody,
  DrawerFooter,
  drawerVariants,
};
