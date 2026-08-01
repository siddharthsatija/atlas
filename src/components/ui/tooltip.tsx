"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/**
 * Tooltip — supplementary hints only.
 *
 * A tooltip must never be the only way to reach information or an action: hover may
 * enhance but never gate (frontend spec §19). Icon-only controls still require an
 * accessible name via aria-label — a tooltip is not a substitute, since touch and
 * screen-reader users may not receive it.
 *
 * Used for collapsed sidebar labels (ATL-006).
 */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 border-border-default bg-surface-raised text-text-primary",
          "rounded-control border px-2.5 py-1.5 text-label",
          "shadow-[--shadow-level-2]",
          "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out",
          "data-[state=delayed-open]:fade-in-0 data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
