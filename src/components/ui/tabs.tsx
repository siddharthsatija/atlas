"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

/**
 * Tabs — Radix implements the ARIA pattern: arrow keys move within the tablist,
 * Tab exits the composite (accessibility skill).
 *
 * Selected state is conveyed by more than color: the active tab carries a border and
 * a text weight change in addition to tone.
 */
const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex items-center gap-1 border-b border-border-default", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "-mb-px border-b-2 border-transparent text-text-secondary hover:text-text-primary",
        "px-3 py-2 text-body-sm font-medium transition-colors duration-[--duration-standard]",
        "data-[state=active]:border-accent data-[state=active]:text-text-primary",
        "data-[state=active]:font-semibold",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content data-slot="tabs-content" className={cn("mt-4", className)} {...props} />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
