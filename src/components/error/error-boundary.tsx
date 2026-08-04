"use client";

import * as React from "react";
import { ErrorFallback } from "./error-fallback";
import { reportError } from "@/lib/telemetry/error-reporter";
import { toUserReference } from "@/lib/telemetry/error-report";

/**
 * Component-level error boundary (ATL-010).
 *
 * Route boundaries (`error.tsx`) are Next.js's job and replace the whole page.
 * This one exists for the opposite case the ticket calls for — "component errors
 * degrade locally". A failing insight card, chart, or assistant panel must not
 * take the dashboard with it, because on this product the surrounding content is
 * exactly what the user came for.
 *
 * A class component is not a style choice: `componentDidCatch` has no hook
 * equivalent, and React has not shipped one.
 *
 * Reporting is intentionally narrow. React hands `componentDidCatch` an
 * `ErrorInfo` containing `componentStack`; it is not forwarded. Component stacks
 * are usually harmless, but they are attacker-useful internal structure and can
 * embed props in some builds, and architecture §16 gives no allowance for them.
 * The boundary reports the same safe-by-construction shape as everything else.
 */

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * Static label identifying the failing region, e.g. "PrivacyScoreCard".
   * Validated against an identifier shape before it is recorded — never
   * interpolate user data into it.
   */
  component?: string;
  /** Concrete pathname for the report. Redacted to a route template downstream. */
  pathname?: string;
  /** Replaces the default inline fallback. Receives a reset callback. */
  fallback?: (context: { reset: () => void; reference?: string }) => React.ReactNode;
  /** Runs before the subtree is remounted — use to clear caches or refetch. */
  onReset?: () => void;
  /**
   * Remounts the subtree when any value changes. Lets a boundary recover on its
   * own when the input that caused the failure is replaced (a different filter,
   * a different record) instead of stranding the user on a dead panel.
   */
  resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
  hasError: boolean;
  /**
   * Required-but-nullable rather than optional: `exactOptionalPropertyTypes`
   * distinguishes "absent" from "present and undefined", and clearing this on
   * reset genuinely sets it to undefined. Declaring it optional would make the
   * reset paths unassignable.
   */
  reference: string | undefined;
  /** Bumped on reset so the subtree remounts rather than re-rendering stale children. */
  resetCount: number;
  resetKeys: readonly unknown[];
}

function keysChanged(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      reference: undefined,
      resetCount: 0,
      resetKeys: props.resetKeys ?? [],
    };
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    // Only the digest is retained — and only because it is a hash. The error
    // object itself is deliberately not stored in state, so it cannot later be
    // rendered by a well-meaning change to this file.
    return { hasError: true, reference: toUserReference(error) };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    const nextKeys = props.resetKeys ?? [];
    if (!keysChanged(state.resetKeys, nextKeys)) return null;
    // Keys changed: adopt them, and clear the error if one is showing.
    return state.hasError
      ? {
          hasError: false,
          reference: undefined,
          resetCount: state.resetCount + 1,
          resetKeys: nextKeys,
        }
      : { resetKeys: nextKeys };
  }

  override componentDidCatch(error: unknown): void {
    reportError({
      error,
      boundary: "component",
      pathname: this.props.pathname ?? "/",
      ...(this.props.component ? { component: this.props.component } : {}),
    });
  }

  private readonly reset = (): void => {
    this.props.onReset?.();
    this.setState((previous) => ({
      hasError: false,
      reference: undefined,
      resetCount: previous.resetCount + 1,
    }));
  };

  override render(): React.ReactNode {
    const { children, fallback } = this.props;
    const { hasError, reference, resetCount } = this.state;

    if (hasError) {
      if (fallback) {
        return fallback({ reset: this.reset, ...(reference ? { reference } : {}) });
      }
      return (
        <ErrorFallback level="section" onRetry={this.reset} {...(reference ? { reference } : {})} />
      );
    }

    // Keyed so a reset remounts children and discards whatever local state led to
    // the failure, rather than re-rendering the same broken tree.
    return <React.Fragment key={resetCount}>{children}</React.Fragment>;
  }
}

export { ErrorBoundary };
