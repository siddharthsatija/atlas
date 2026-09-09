/**
 * ThemeProvider — Phase 1 contract regression guard.
 *
 * Contract (PRD §5.7, design system §2):
 *   - Atlas launches in light mode unconditionally.
 *   - OS/system preference must NOT determine the initial theme.
 *   - Explicit user opt-in to dark mode remains supported via next-themes'
 *     class strategy and localStorage persistence (unchanged).
 *
 * We mock `next-themes` to capture the props forwarded to NextThemesProvider.
 * This is a prop-contract test, not a behavioral test of next-themes itself.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "./theme-provider";

// Capture the props passed to NextThemesProvider on each render.
const captured: Record<string, unknown>[] = [];

vi.mock("next-themes", () => ({
  ThemeProvider: (props: Record<string, unknown>) => {
    captured.push(props);
    // Render children so the tree is valid.
    return <>{props.children}</>;
  },
}));

describe("ThemeProvider — Phase 1 contract", () => {
  it("sets defaultTheme to light (PRD §5.7, design system §2)", () => {
    captured.length = 0;
    render(<ThemeProvider>content</ThemeProvider>);
    expect(captured[0]?.defaultTheme).toBe("light");
  });

  it("explicitly disables system-preference resolution (enableSystem = false)", () => {
    captured.length = 0;
    render(<ThemeProvider>content</ThemeProvider>);
    expect(captured[0]?.enableSystem).toBe(false);
  });

  it("uses class strategy so dark mode is toggled via the html class attribute", () => {
    captured.length = 0;
    render(<ThemeProvider>content</ThemeProvider>);
    expect(captured[0]?.attribute).toBe("class");
  });

  it("disables theme-change CSS transitions to prevent flash", () => {
    captured.length = 0;
    render(<ThemeProvider>content</ThemeProvider>);
    expect(captured[0]?.disableTransitionOnChange).toBe(true);
  });

  it("forwards nonce prop for CSP compliance (ATL-087)", () => {
    captured.length = 0;
    render(<ThemeProvider nonce="test-nonce-123">content</ThemeProvider>);
    expect(captured[0]?.nonce).toBe("test-nonce-123");
  });

  it("renders children", () => {
    render(<ThemeProvider>hello world</ThemeProvider>);
    expect(screen.getByText("hello world")).toBeTruthy();
  });
});
