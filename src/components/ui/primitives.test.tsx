import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { LayersIcon } from "lucide-react";
import { Badge } from "./badge";
import { Input } from "./input";
import { Label } from "./label";
import { Skeleton } from "./skeleton";
import { EmptyState } from "./empty-state";
import { SEVERITY_VALUES, SeverityBadge } from "./severity-badge";
import { STATUS_VALUES, StatusBadge } from "./status-badge";
import { Button } from "./button";

/**
 * ATL-009 — remaining primitives.
 *
 * Focus: the states required by frontend §18 and design system §9–§12, and the
 * criterion that severity and status badges always carry text.
 */

const COMPONENT_AXE_OPTIONS = { rules: { region: { enabled: false } } };

describe("Input — states (frontend §18)", () => {
  it("uses border-strong so the control boundary meets SC 1.4.11", () => {
    // border-default is decorative only (design system §2.4, set by ATL-008).
    render(<Input aria-label="Service name" />);
    const input = screen.getByRole("textbox", { name: "Service name" });
    expect(input.className).toContain("border-border-strong");
    expect(input.className).not.toContain("border-border-default");
  });

  it("is default state with no aria-invalid", () => {
    render(<Input aria-label="Service" />);
    expect(screen.getByRole("textbox")).not.toHaveAttribute("aria-invalid");
  });

  it("sets aria-invalid in the error state", () => {
    render(<Input aria-label="Service" state="error" />);
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("marks the success state without claiming invalidity", () => {
    render(<Input aria-label="Service" state="success" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("data-state", "success");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("supports the disabled state", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Service" disabled />);
    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
    await user.type(input, "abc");
    expect(input).toHaveValue("");
  });

  it("supports read-only without leaving the tab order", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Service" readOnly defaultValue="fixed" />);
    await user.tab();
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("announces the loading state and stays focusable", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Service" loading />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Checking…");
    await user.tab();
    expect(input).toHaveFocus();
  });

  it("accepts typed input and preserves it", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Service" />);
    await user.type(screen.getByRole("textbox"), "ExampleShop");
    expect(screen.getByRole("textbox")).toHaveValue("ExampleShop");
  });

  it("associates with a visible label", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Label htmlFor="svc">Service name</Label>
        <Input id="svc" />
      </>,
    );
    await user.click(screen.getByText("Service name"));
    expect(screen.getByRole("textbox", { name: "Service name" })).toHaveFocus();
  });

  it.each(["default", "error", "success"] as const)(
    "has no violations in %s state",
    async (state) => {
      const { container } = render(<Input aria-label="Service" state={state} />);
      expect(await axe(container, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
    },
  );
});

describe("StatusBadge — text, never colour alone", () => {
  it.each(STATUS_VALUES)("renders a text label for %s", (status) => {
    render(<StatusBadge status={status} />);
    // Every status must be legible without perceiving colour.
    expect(screen.getByText(new RegExp(status, "i"))).toBeInTheDocument();
  });

  it("exposes the status as data for styling without encoding meaning in colour", () => {
    render(<StatusBadge status="completed" data-testid="badge" />);
    expect(screen.getByTestId("badge")).toHaveAttribute("data-status", "completed");
  });

  it("allows a custom label but still renders text", () => {
    render(<StatusBadge status="pending" label="Awaiting response" />);
    expect(screen.getByText("Awaiting response")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<StatusBadge status="active" />);
    expect(await axe(container, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe("SeverityBadge — text, never colour alone", () => {
  it.each(SEVERITY_VALUES)("renders a text label for %s", (severity) => {
    render(<SeverityBadge severity={severity} />);
    expect(screen.getByText(new RegExp(severity, "i"))).toBeInTheDocument();
  });

  it("prefixes the meaning for screen readers", () => {
    render(<SeverityBadge severity="high" />);
    expect(screen.getByText("Severity:")).toBeInTheDocument();
  });

  it("reserves the danger tone for critical only", () => {
    // "Danger is reserved for destructive actions or verified critical risk."
    const { unmount } = render(<SeverityBadge severity="critical" data-testid="sev" />);
    expect(screen.getByTestId("sev").className).toContain("danger");
    unmount();

    render(<SeverityBadge severity="high" data-testid="sev" />);
    expect(screen.getByTestId("sev").className).not.toContain("bg-danger");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<SeverityBadge severity="critical" />);
    expect(await axe(container, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe("EmptyState", () => {
  it("teaches rather than just reporting emptiness", () => {
    render(
      <EmptyState
        title="No digital assets yet"
        description="A digital asset is a service that holds information about you."
        icon={LayersIcon}
        action={<Button>Add your first asset</Button>}
      />,
    );
    expect(screen.getByText("No digital assets yet")).toBeInTheDocument();
    expect(screen.getByText(/service that holds information/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add your first asset" })).toBeInTheDocument();
  });

  it("distinguishes first-run from filtered", () => {
    const { unmount } = render(<EmptyState title="Nothing yet" data-testid="empty" />);
    expect(screen.getByTestId("empty")).toHaveAttribute("data-variant", "first-run");
    unmount();

    render(<EmptyState title="No matches" variant="filtered" data-testid="empty" />);
    expect(screen.getByTestId("empty")).toHaveAttribute("data-variant", "filtered");
  });

  it("keeps the decorative icon out of the accessibility tree", () => {
    // If the icon were exposed it would be an unnamed graphic in the a11y tree;
    // the heading and description carry the meaning instead.
    render(<EmptyState title="Nothing yet" icon={LayersIcon} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <EmptyState title="Nothing yet" description="Explanation." icon={LayersIcon} />,
    );
    expect(await axe(container, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe("Skeleton", () => {
  it("is hidden from assistive technology", () => {
    // The owning region announces loading; the skeleton itself is decorative.
    render(<Skeleton className="h-4 w-32" data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Badge", () => {
  it("renders its children as text", () => {
    render(<Badge tone="info">Demo data</Badge>);
    expect(screen.getByText("Demo data")).toBeInTheDocument();
  });
});

describe("Button — remaining states (design system §9)", () => {
  it.each(["primary", "secondary", "tertiary", "destructive", "icon", "link"] as const)(
    "renders the %s variant",
    (variant) => {
      render(<Button variant={variant}>Action</Button>);
      expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
    },
  );

  it.each([
    ["sm", "h-8"],
    ["md", "h-10"],
    ["lg", "h-12"],
  ] as const)("size %s maps to the documented height", (size, height) => {
    render(<Button size={size}>Action</Button>);
    expect(screen.getByRole("button")).toHaveClass(height);
  });

  it("does not fire while disabled", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={onClick}>
        Action
      </Button>,
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("uses the adaptive fill foreground rather than a literal colour", () => {
    // ATL-008: white-on-accent fails contrast in dark mode.
    render(<Button variant="primary">Action</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("text-accent-foreground");
    expect(button.className).not.toContain("text-white");
  });
});
