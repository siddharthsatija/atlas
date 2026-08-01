"use client";

import * as React from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * SensitiveValue — masked display with deliberate, temporary reveal (ATL-009).
 *
 * Security §8 requires emails, phone numbers, and account identifiers to be masked
 * by default and revealed only deliberately. This primitive is the single place
 * that behavior lives, so no surface can improvise it.
 *
 * Three rules this component enforces structurally:
 *
 *  1. **It never receives the full value up front.** The caller passes a masked
 *     string plus an `onReveal` resolver. Until the user acts, the unmasked value
 *     is not in the DOM, not in the accessibility tree, and not in a React prop —
 *     so it cannot leak through a screenshot, a serialized payload, or devtools.
 *  2. **Reveal is temporary.** It re-masks automatically, so a value cannot be left
 *     exposed on an unattended screen.
 *  3. **Reveal is auditable.** Every transition emits an event carrying the field
 *     label and entity reference but **never the value** (security §12, ADR-006).
 *
 * Scope: this is the primitive and its audit *seam*. Applying it across product
 * surfaces is ATL-035; persisting the events is ATL-103. Nothing here writes to a
 * store — the caller supplies `onAuditEvent`.
 */

export type SensitiveValueAuditReason = "user_action" | "auto_hide" | "manual_hide";

/**
 * Emitted on every reveal/hide transition.
 *
 * Deliberately has no field capable of carrying the sensitive value. Adding one
 * would turn the audit trail into a second copy of the data it protects
 * (ADR-006: "audit data must not duplicate sensitive content").
 */
export interface SensitiveValueAuditEvent {
  type: "sensitive_value_revealed" | "sensitive_value_hidden";
  /** What kind of value this was, e.g. "Account identifier". Never the value. */
  field: string;
  /** Optional entity the value belongs to, for correlation. */
  entityType?: string;
  entityId?: string;
  reason: SensitiveValueAuditReason;
  occurredAt: string;
}

export interface SensitiveValueProps extends Omit<React.ComponentProps<"span">, "onError"> {
  /**
   * The masked representation, e.g. `••••••@example.com` or `····4821`.
   * Safe to render; must already be redacted by the caller.
   */
  masked: string;
  /**
   * Resolves the full value on demand. May be async so a surface can fetch it
   * server-side at reveal time rather than shipping it to the browser eagerly.
   */
  onReveal: () => string | Promise<string>;
  /** Describes the value for assistive technology, e.g. "Account identifier". */
  label: string;
  /** Audit seam. Wired to the audit writer by ATL-103. */
  onAuditEvent?: (event: SensitiveValueAuditEvent) => void;
  entityType?: string;
  entityId?: string;
  /** How long the value stays visible before re-masking. */
  revealDurationMs?: number;
  disabled?: boolean;
}

type Status = "masked" | "loading" | "revealed" | "error";

/** Long enough to read a value, short enough not to linger on an idle screen. */
const DEFAULT_REVEAL_DURATION_MS = 15_000;

function SensitiveValue({
  masked,
  onReveal,
  label,
  onAuditEvent,
  entityType,
  entityId,
  revealDurationMs = DEFAULT_REVEAL_DURATION_MS,
  disabled = false,
  className,
  ...props
}: SensitiveValueProps) {
  const [status, setStatus] = React.useState<Status>("masked");
  const [value, setValue] = React.useState<string | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow reveal resolving after unmount.
  const mountedRef = React.useRef(true);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const emit = React.useCallback(
    (type: SensitiveValueAuditEvent["type"], reason: SensitiveValueAuditReason) => {
      onAuditEvent?.({
        type,
        field: label,
        ...(entityType === undefined ? {} : { entityType }),
        ...(entityId === undefined ? {} : { entityId }),
        reason,
        occurredAt: new Date().toISOString(),
      });
    },
    [onAuditEvent, label, entityType, entityId],
  );

  const hide = React.useCallback(
    (reason: SensitiveValueAuditReason) => {
      clearTimer();
      setValue(null);
      setStatus("masked");
      emit("sensitive_value_hidden", reason);
    },
    [clearTimer, emit],
  );

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Never leave a re-mask timer running after unmount.
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  async function reveal() {
    setStatus("loading");
    try {
      const resolved = await onReveal();
      if (!mountedRef.current) return;

      setValue(resolved);
      setStatus("revealed");
      emit("sensitive_value_revealed", "user_action");

      clearTimer();
      timerRef.current = setTimeout(() => {
        if (mountedRef.current) hide("auto_hide");
      }, revealDurationMs);
    } catch {
      if (!mountedRef.current) return;
      // The underlying reason is deliberately not surfaced: it may describe why a
      // protected value could not be read.
      setStatus("error");
      setValue(null);
    }
  }

  function toggle() {
    if (disabled) return;
    if (status === "revealed") {
      hide("manual_hide");
      return;
    }
    if (status === "loading") return;
    void reveal();
  }

  const isRevealed = status === "revealed" && value !== null;

  return (
    <span
      data-slot="sensitive-value"
      data-status={status}
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    >
      <span
        data-slot="sensitive-value-text"
        className={cn(
          "font-mono text-body-sm tabular-nums",
          status === "error" ? "text-danger" : "text-text-primary",
        )}
        // While masked, assistive technology gets the masked string only — the
        // same information a sighted user has. Announcing the full value here
        // would defeat masking for screen-reader users.
        aria-label={isRevealed ? `${label}, revealed` : `${label}, hidden`}
      >
        {isRevealed ? value : masked}
      </span>

      <button
        type="button"
        onClick={toggle}
        disabled={disabled || status === "loading"}
        aria-pressed={isRevealed}
        aria-label={isRevealed ? `Hide ${label}` : `Reveal ${label}`}
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-control text-text-secondary",
          "transition-colors duration-[--duration-standard]",
          "hover:bg-surface-subtle hover:text-text-primary",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        {status === "loading" ? (
          <Spinner className="size-4" />
        ) : isRevealed ? (
          <EyeOffIcon aria-hidden="true" className="size-4" />
        ) : (
          <EyeIcon aria-hidden="true" className="size-4" />
        )}
      </button>

      {/* Announces the transition without ever announcing the value itself. */}
      <span role="status" aria-live="polite" className="sr-only">
        {status === "revealed" && `${label} revealed. It will hide automatically.`}
        {status === "error" && `${label} could not be revealed.`}
      </span>
    </span>
  );
}

export { SensitiveValue, DEFAULT_REVEAL_DURATION_MS };
