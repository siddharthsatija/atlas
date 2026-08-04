import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ErrorBoundary } from "./error-boundary";
import { ErrorFallback } from "./error-fallback";
import { RouteError } from "./route-error";
import { resetErrorSink, setErrorSink } from "@/lib/telemetry/error-reporter";
import type { ErrorReport } from "@/lib/telemetry/error-report";

/**
 * ATL-010 — error boundaries.
 *
 * Forced-error fixtures at both levels, plus assertions on the reported payload.
 * The security-critical assertion is not "an error page appeared": it is that a
 * message stuffed with restricted data reaches neither the DOM nor the sink.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/assets/8f14e45f-ceea-467a" }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

/**
 * A message containing every category architecture §16 forbids. Any of these
 * strings appearing in the DOM or in a report is a privacy failure.
 */
const POISONED_MESSAGE =
  "Failed for Dana Whitfield <dana@example.com>, phone 555-0100, 42 Roseway Ave, " +
  'token sk_live_9f2b7c1d, body {"draft":"Please delete my account"}';

const RESTRICTED_FRAGMENTS = [
  "Dana Whitfield",
  "dana@example.com",
  "555-0100",
  "Roseway",
  "sk_live_9f2b7c1d",
  "Please delete my account",
];

/**
 * Component-level axe options.
 *
 * `region` is a page-level rule — it requires all content to sit inside a
 * landmark, which no component rendered standalone can satisfy. Landmark coverage
 * is asserted against the real shell in the ATL-005 tests.
 */
const COMPONENT_AXE_OPTIONS = { rules: { region: { enabled: false } } };

/**
 * Throws while `state.shouldThrow` holds, so a test can make the underlying
 * condition go away and prove that retry recovers.
 *
 * The condition is read, never mutated, during render. A fixture that
 * decremented a counter on each render looked equivalent but was not: when a
 * component throws during a concurrent render, React discards that render and
 * retries the whole root synchronously, so the counter was consumed twice and the
 * second attempt succeeded before the boundary ever caught anything.
 */
function ConditionalThrow({ state }: { state: { shouldThrow: boolean } }) {
  if (state.shouldThrow) {
    throw Object.assign(new Error(POISONED_MESSAGE), { digest: "a1b2c3" });
  }
  return <p>Recovered content</p>;
}

function AlwaysThrows(): React.ReactNode {
  throw new Error(POISONED_MESSAGE);
}

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  // React logs every caught error to the console by design. Silenced so the run
  // is readable; the boundary's own reporting is asserted through the sink.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  resetErrorSink();
});

describe("ErrorBoundary (component level)", () => {
  it("degrades locally and leaves sibling content intact", () => {
    render(
      <div>
        <p>Sibling content</p>
        <ErrorBoundary component="InsightCard">
          <AlwaysThrows />
        </ErrorBoundary>
      </div>,
    );

    expect(screen.getByText("Sibling content")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This section could not be displayed");
  });

  it("never renders the error message or stack", () => {
    render(
      <ErrorBoundary component="InsightCard">
        <AlwaysThrows />
      </ErrorBoundary>,
    );

    for (const fragment of RESTRICTED_FRAGMENTS) {
      expect(document.body.textContent).not.toContain(fragment);
    }
    expect(document.body.textContent).not.toMatch(/\bat \w+ \(/); // no stack frames
  });

  it("reports a redacted payload containing no restricted data", () => {
    const sink = vi.fn<(report: ErrorReport) => void>();
    setErrorSink(sink);

    render(
      <ErrorBoundary component="InsightCard" pathname="/assets/8f14e45f-ceea-467a">
        <AlwaysThrows />
      </ErrorBoundary>,
    );

    expect(sink).toHaveBeenCalledTimes(1);
    const [report] = sink.mock.calls[0]!;
    expect(report.boundary).toBe("component");
    expect(report.component).toBe("InsightCard");
    expect(report.route).toBe("/assets/:id");

    const serialised = JSON.stringify(report);
    for (const fragment of RESTRICTED_FRAGMENTS) {
      expect(serialised).not.toContain(fragment);
    }
    // The component stack React supplies is deliberately not forwarded.
    expect(serialised).not.toMatch(/componentStack|stack|message/i);
  });

  it("restores the subtree on retry without a reload", async () => {
    const user = userEvent.setup();
    const state = { shouldThrow: true };

    render(
      <ErrorBoundary component="InsightCard">
        <ConditionalThrow state={state} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    // The transient condition clears, exactly as a failed fetch would on retry.
    state.shouldThrow = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("runs onReset before remounting so callers can clear the failed input", async () => {
    const user = userEvent.setup();
    const state = { shouldThrow: true };
    // The ordering is the contract: if `onReset` ran after the remount, the
    // subtree would re-render against the same broken input and fail again.
    const onReset = vi.fn(() => {
      state.shouldThrow = false;
    });

    render(
      <ErrorBoundary onReset={onReset}>
        <ConditionalThrow state={state} />
      </ErrorBoundary>,
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Recovered content")).toBeInTheDocument();
  });

  it("recovers on its own when a resetKey changes", async () => {
    const state = { shouldThrow: true };

    function Harness() {
      const [assetId, setAssetId] = React.useState("a");
      return (
        <>
          <button
            type="button"
            onClick={() => {
              state.shouldThrow = false;
              setAssetId("b");
            }}
          >
            Open other asset
          </button>
          <ErrorBoundary resetKeys={[assetId]}>
            <ConditionalThrow state={state} />
          </ErrorBoundary>
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Selecting a different record replaces the input that failed — the panel
    // recovers without the user having to find a retry button.
    await user.click(screen.getByRole("button", { name: "Open other asset" }));
    expect(await screen.findByText("Recovered content")).toBeInTheDocument();
  });

  it("renders a custom fallback with the reset callback and reference", async () => {
    const user = userEvent.setup();
    const state = { shouldThrow: true };

    render(
      <ErrorBoundary
        fallback={({ reset, reference }) => (
          <div>
            <p>Custom fallback {reference}</p>
            <button type="button" onClick={reset}>
              Retry panel
            </button>
          </div>
        )}
      >
        <ConditionalThrow state={state} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Custom fallback a1b2c3/)).toBeInTheDocument();

    state.shouldThrow = false;
    await user.click(screen.getByRole("button", { name: "Retry panel" }));
    expect(await screen.findByText("Recovered content")).toBeInTheDocument();
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>Healthy content</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Healthy content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("has no accessibility violations in its failed state", async () => {
    const { container } = render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    );
    expect(await axe(container, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe("RouteError (route level)", () => {
  function renderRouteError(overrides: Partial<Parameters<typeof RouteError>[0]> = {}) {
    const reset = vi.fn();
    const error = Object.assign(new Error(POISONED_MESSAGE), { digest: "d4e5f6" });
    render(
      <RouteError
        error={error}
        reset={reset}
        homeHref="/overview"
        homeLabel="Go to Overview"
        {...overrides}
      />,
    );
    return { reset };
  }

  it("renders a calm recovery page with a heading and no error detail", () => {
    renderRouteError();

    expect(
      screen.getByRole("heading", { level: 1, name: "This page could not be displayed" }),
    ).toBeInTheDocument();
    for (const fragment of RESTRICTED_FRAGMENTS) {
      expect(document.body.textContent).not.toContain(fragment);
    }
  });

  it("preserves navigation with a route back to a known-good page", () => {
    renderRouteError();
    expect(screen.getByRole("link", { name: "Go to Overview" })).toHaveAttribute(
      "href",
      "/overview",
    );
  });

  it("moves focus to the heading so keyboard users are not stranded", async () => {
    renderRouteError();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    });
  });

  it("calls reset when retried, without reloading", async () => {
    const user = userEvent.setup();
    const { reset } = renderRouteError();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("shows the digest as the support reference", () => {
    renderRouteError();
    expect(screen.getByTestId("error-reference-code")).toHaveTextContent("d4e5f6");
  });

  it("shows no reference at all when there is no digest", () => {
    // Better to show nothing than a fabricated code that resolves to nothing.
    renderRouteError({ error: new Error(POISONED_MESSAGE) });
    expect(screen.queryByTestId("error-reference-code")).not.toBeInTheDocument();
  });

  it("reports the route boundary with a redacted route template", () => {
    const sink = vi.fn<(report: ErrorReport) => void>();
    setErrorSink(sink);
    renderRouteError();

    expect(sink).toHaveBeenCalledTimes(1);
    const [report] = sink.mock.calls[0]!;
    expect(report).toMatchObject({ boundary: "route", route: "/assets/:id", digest: "d4e5f6" });
    for (const fragment of RESTRICTED_FRAGMENTS) {
      expect(JSON.stringify(report)).not.toContain(fragment);
    }
  });

  it("has no accessibility violations", async () => {
    const reset = vi.fn();
    const { container } = render(
      <RouteError
        error={new Error("x")}
        reset={reset}
        homeHref="/overview"
        homeLabel="Go to Overview"
      />,
    );
    expect(await axe(container, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe("ErrorFallback", () => {
  it("exposes no prop capable of carrying an error", () => {
    // Compile-time guarantee, asserted at runtime for documentation value: the
    // component is driven entirely by strings the caller chose.
    render(<ErrorFallback level="section" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("announces section failures politely without stealing focus", () => {
    render(
      <>
        <button type="button">Elsewhere on the page</button>
        <ErrorFallback level="section" />
      </>,
    );
    const other = screen.getByRole("button", { name: "Elsewhere on the page" });
    other.focus();
    expect(other).toHaveFocus();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows a loading state while a retry is in flight", () => {
    render(<ErrorFallback level="page" retrying onRetry={() => {}} />);
    const button = screen.getByRole("button", { name: /Try again/ });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
  });

  it("uses a heading level appropriate to its context", () => {
    const { unmount } = render(<ErrorFallback level="page" />);
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    unmount();

    // A section failure sits inside a page that still has its own h1.
    render(<ErrorFallback level="section" />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
  });

  it("uses calm, non-alarming copy", () => {
    render(<ErrorFallback level="section" />);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).not.toMatch(/!|fatal|crash|danger/i);
  });

  it("has no accessibility violations at page level", async () => {
    const { container } = render(
      <ErrorFallback level="page" reference="abc123" onRetry={() => {}} />,
    );
    expect(await axe(container, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });

  it("has no accessibility violations at section level", async () => {
    const { container } = render(<ErrorFallback level="section" onRetry={() => {}} />);
    expect(await axe(container, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });
});
