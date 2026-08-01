import {
  ArchiveIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleIcon,
  ClockIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeProps } from "./badge";

/**
 * StatusBadge — design system §12.
 *
 * Every status carries a **text label**; colour and icon are supplementary. This is
 * the acceptance criterion "status badges include text, never colour alone", and it
 * is also what makes the badge legible to someone with a colour vision deficiency
 * or reading a greyscale print.
 *
 * Domain wrapper over the domain-free `Badge` primitive.
 */
export const STATUS_VALUES = [
  "neutral",
  "active",
  "pending",
  "completed",
  "archived",
  "rejected",
] as const;

export type Status = (typeof STATUS_VALUES)[number];

const STATUS_CONFIG: Record<Status, { label: string; tone: BadgeProps["tone"]; icon: LucideIcon }> =
  {
    neutral: { label: "Neutral", tone: "neutral", icon: CircleIcon },
    active: { label: "Active", tone: "info", icon: CircleDashedIcon },
    pending: { label: "Pending", tone: "warning", icon: ClockIcon },
    completed: { label: "Completed", tone: "success", icon: CheckCircle2Icon },
    archived: { label: "Archived", tone: "neutral", icon: ArchiveIcon },
    rejected: { label: "Rejected", tone: "danger", icon: XCircleIcon },
  };

export interface StatusBadgeProps extends Omit<BadgeProps, "tone" | "children"> {
  status: Status;
  /** Overrides the default label; the badge always renders text. */
  label?: string;
}

function StatusBadge({ status, label, ...props }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <Badge tone={config.tone} data-status={status} {...props}>
      <Icon aria-hidden="true" />
      {label ?? config.label}
    </Badge>
  );
}

export { StatusBadge, STATUS_CONFIG };
