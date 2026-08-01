import {
  AlertOctagonIcon,
  AlertTriangleIcon,
  InfoIcon,
  ShieldAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeProps } from "./badge";

/**
 * SeverityBadge — design system §12.
 *
 * Severity always carries a **text label**; colour and icon are supplementary
 * ("severity never relies on colour alone", design system §2).
 *
 * `critical` is the only severity that uses the danger tone, honouring "danger is
 * reserved for destructive actions or verified critical risk". `high` uses warning
 * so that a genuinely critical finding remains visually distinct rather than
 * competing with a wall of red.
 */
export const SEVERITY_VALUES = ["low", "medium", "high", "critical"] as const;

export type Severity = (typeof SEVERITY_VALUES)[number];

const SEVERITY_CONFIG: Record<
  Severity,
  { label: string; tone: BadgeProps["tone"]; icon: LucideIcon }
> = {
  low: { label: "Low", tone: "info", icon: InfoIcon },
  medium: { label: "Medium", tone: "warning", icon: AlertTriangleIcon },
  high: { label: "High", tone: "warning", icon: AlertOctagonIcon },
  critical: { label: "Critical", tone: "danger", icon: ShieldAlertIcon },
};

export interface SeverityBadgeProps extends Omit<BadgeProps, "tone" | "children"> {
  severity: Severity;
  label?: string;
}

function SeverityBadge({ severity, label, ...props }: SeverityBadgeProps) {
  const config = SEVERITY_CONFIG[severity];
  const Icon = config.icon;

  return (
    <Badge tone={config.tone} data-severity={severity} {...props}>
      <Icon aria-hidden="true" />
      {/* Prefixed so the meaning is unambiguous when read out of context. */}
      <span className="sr-only">Severity: </span>
      {label ?? config.label}
    </Badge>
  );
}

export { SeverityBadge, SEVERITY_CONFIG };
