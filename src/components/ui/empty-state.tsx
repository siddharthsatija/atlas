import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * EmptyState (ATL-009).
 *
 * Frontend §18 requires an empty state wherever one is relevant, and the product
 * principles require it to *teach*: explain the concept and offer the next step,
 * rather than showing a bare "No results".
 *
 * Two distinct situations, and conflating them is a real UX failure:
 *   - `variant="first-run"` — nothing exists yet. Explain what the thing is.
 *   - `variant="filtered"`  — things exist but none match. Offer to clear filters.
 *
 * The icon is decorative: the heading and description carry the meaning, so the
 * state is never conveyed by imagery alone.
 */
export interface EmptyStateProps extends React.ComponentProps<"div"> {
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** Primary action, e.g. "Add your first asset" or "Clear filters". */
  action?: React.ReactNode;
  /** Secondary action, e.g. "Learn how Atlas finds assets". */
  secondaryAction?: React.ReactNode;
  variant?: "first-run" | "filtered";
}

function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  secondaryAction,
  variant = "first-run",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      data-variant={variant}
      className={cn(
        "flex flex-col items-center gap-3 border-border-default bg-surface",
        "rounded-card border border-dashed px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      {Icon && (
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-full bg-surface-subtle text-text-muted"
        >
          <Icon className="size-6" />
        </span>
      )}

      <div className="flex flex-col gap-1">
        <p data-slot="empty-state-title" className="text-body font-medium">
          {title}
        </p>
        {description && (
          <p
            data-slot="empty-state-description"
            className="max-w-prose text-body-sm text-text-secondary"
          >
            {description}
          </p>
        )}
      </div>

      {(action ?? secondaryAction) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export { EmptyState };
