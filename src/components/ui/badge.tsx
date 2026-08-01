import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge — design system §12.
 *
 * Status and severity badges MUST include a text label. Color alone never conveys
 * meaning (design system §2, accessibility skill). Domain-aware wrappers
 * (StatusBadge, SeverityBadge) are built on top of this and own their icon and
 * label mapping; this primitive stays domain-free.
 *
 * `danger` is reserved for verified critical risk or destructive context.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-label font-medium [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-surface-subtle text-text-secondary border border-border-default",
        accent: "bg-accent-subtle text-accent border border-accent/20",
        success: "bg-success/10 text-success border border-success/20",
        warning: "bg-warning/10 text-warning border border-warning/20",
        danger: "bg-danger/10 text-danger border border-danger/20",
        info: "bg-info/10 text-info border border-info/20",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

function Badge({ className, tone, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
