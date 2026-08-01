import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SensitiveValue, type SensitiveValueAuditEvent } from "./sensitive-value";

/**
 * ATL-009 — SensitiveValue.
 *
 * The security-critical primitive: masks by default, reveal is explicit and
 * temporary, and every transition is auditable without the audit trail ever
 * carrying the value (security §8, §12; ADR-006).
 */

const MASKED = "••••4821";
const SECRET = "4111111111114821";

afterEach(() => {
  vi.useRealTimers();
});

function setup(overrides: Partial<React.ComponentProps<typeof SensitiveValue>> = {}) {
  const onAuditEvent = vi.fn<(event: SensitiveValueAuditEvent) => void>();
  const onReveal = vi.fn(() => SECRET);
  render(
    <SensitiveValue
      masked={MASKED}
      onReveal={onReveal}
      label="Account identifier"
      onAuditEvent={onAuditEvent}
      {...overrides}
    />,
  );
  return { onAuditEvent, onReveal };
}

describe("masking", () => {
  it("masks by default and never renders the value", () => {
    setup();
    expect(screen.getByText(MASKED)).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("does not call the resolver until the user asks", () => {
    const { onReveal } = setup();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("announces the masked state without announcing the value", () => {
    setup();
    // Assistive technology gets the same information a sighted user has.
    expect(screen.getByLabelText("Account identifier, hidden")).toHaveTextContent(MASKED);
  });
});

describe("explicit reveal", () => {
  it("reveals on click", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
  });

  it("reveals by keyboard alone", async () => {
    const user = userEvent.setup();
    setup();
    await user.tab();
    expect(screen.getByRole("button", { name: /Reveal/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
  });

  it("exposes pressed state to assistive technology", async () => {
    const user = userEvent.setup();
    setup();
    const toggle = screen.getByRole("button", { name: /Reveal/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(await screen.findByRole("button", { name: /Hide/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hides again on a second activation", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    await user.click(await screen.findByRole("button", { name: /Hide/ }));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.getByText(MASKED)).toBeInTheDocument();
  });

  it("supports an async resolver so the value can be fetched on demand", async () => {
    const user = userEvent.setup();
    setup({ onReveal: () => Promise.resolve(SECRET) });
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
  });
});

describe("temporary reveal", () => {
  it("re-masks automatically after the reveal window", async () => {
    // Real timers with a short window: fake timers deadlock against the async
    // resolver, and `waitFor` waits on state rather than on a fixed sleep.
    const user = userEvent.setup();
    const onAuditEvent = vi.fn<(event: SensitiveValueAuditEvent) => void>();
    render(
      <SensitiveValue
        masked={MASKED}
        onReveal={() => SECRET}
        label="Account identifier"
        onAuditEvent={onAuditEvent}
        revealDurationMs={50}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();

    // A value must never be left exposed on an unattended screen.
    await waitFor(() => {
      expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    });
    expect(screen.getByText(MASKED)).toBeInTheDocument();
    expect(onAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "sensitive_value_hidden", reason: "auto_hide" }),
    );
  });

  it("clears its timer on unmount", async () => {
    // A pending re-mask must not fire against an unmounted tree.
    const user = userEvent.setup();
    const { unmount } = render(
      <SensitiveValue
        masked={MASKED}
        onReveal={() => SECRET}
        label="Account identifier"
        revealDurationMs={50}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    await screen.findByText(SECRET);
    expect(() => unmount()).not.toThrow();
  });
});

describe("audit seam", () => {
  it("emits a reveal event attributed to the user", async () => {
    const user = userEvent.setup();
    const { onAuditEvent } = setup({ entityType: "digital_asset", entityId: "asset-1" });

    await user.click(screen.getByRole("button", { name: /Reveal/ }));

    expect(onAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sensitive_value_revealed",
        field: "Account identifier",
        entityType: "digital_asset",
        entityId: "asset-1",
        reason: "user_action",
      }),
    );
  });

  it("distinguishes a manual hide from an automatic one", async () => {
    const user = userEvent.setup();
    const { onAuditEvent } = setup();
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    await user.click(await screen.findByRole("button", { name: /Hide/ }));

    expect(onAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "sensitive_value_hidden", reason: "manual_hide" }),
    );
  });

  it("NEVER includes the value in an audit event", async () => {
    const user = userEvent.setup();
    const { onAuditEvent } = setup();
    await user.click(screen.getByRole("button", { name: /Reveal/ }));

    // ADR-006: audit data must not duplicate sensitive content.
    for (const call of onAuditEvent.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(SECRET);
      expect(JSON.stringify(call[0])).not.toContain(MASKED);
    }
  });

  it("records the time of the transition", async () => {
    const user = userEvent.setup();
    const { onAuditEvent } = setup();
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    const event = onAuditEvent.mock.calls[0]?.[0];
    expect(event?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("works without an audit handler", async () => {
    const user = userEvent.setup();
    render(<SensitiveValue masked={MASKED} onReveal={() => SECRET} label="Phone" />);
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
  });
});

describe("failure and disabled states", () => {
  it("reports an error without leaking why", async () => {
    const user = userEvent.setup();
    setup({
      onReveal: () => {
        throw new Error("decryption failed for key kek-v1");
      },
    });

    await user.click(screen.getByRole("button", { name: /Reveal/ }));

    expect(await screen.findByText(/could not be revealed/)).toBeInTheDocument();
    // The underlying reason may describe a protected system; it is not surfaced.
    expect(screen.queryByText(/decryption failed/)).not.toBeInTheDocument();
    expect(screen.getByText(MASKED)).toBeInTheDocument();
  });

  it("cannot be revealed when disabled", async () => {
    const user = userEvent.setup();
    const { onReveal } = setup({ disabled: true });
    const toggle = screen.getByRole("button", { name: /Reveal/ });

    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(onReveal).not.toHaveBeenCalled();
  });
});

describe("accessibility", () => {
  it("has no violations while masked", async () => {
    const { container } = render(
      <SensitiveValue masked={MASKED} onReveal={() => SECRET} label="Account identifier" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations while revealed", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SensitiveValue masked={MASKED} onReveal={() => SECRET} label="Account identifier" />,
    );
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    await screen.findByText(SECRET);
    expect(await axe(container)).toHaveNoViolations();
  });
});
