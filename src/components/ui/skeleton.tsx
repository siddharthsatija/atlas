import { cn } from "@/lib/utils";

/**
 * Skeleton — must resemble the final structure it replaces (frontend spec §18).
 *
 * Reserve the same layout space as the loaded content so nothing shifts
 * (performance skill: CLS budget).
 *
 * The container that owns the loading region announces status via aria-live; this
 * element is decorative and hidden from assistive technology.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-control bg-surface-subtle", className)}
      {...props}
    />
  );
}
