import type { Metadata, Viewport } from "next";
import { AppProviders } from "@/providers";
import { APP_NAME } from "@/config/app";
import "@/styles/globals.css";

/**
 * Root layout.
 *
 * The product shell (sidebar, top bar, content region) is not here — it belongs to
 * the (product) route group and is owned by ATL-005. This layout provides only the
 * document, fonts, providers, and the skip link.
 */

/**
 * Typography is supplied by the `--font-sans` token (src/styles/tokens.css), which
 * declares Inter with a neutral system fallback stack.
 *
 * `next/font/google` is deliberately NOT used: it fetches the font from Google at
 * build time, which makes builds non-hermetic, fails in restricted-network CI, and
 * adds a third-party build dependency to a privacy product. Design system §3 permits
 * "Inter or a similarly neutral, highly legible sans serif", so the fallback stack is
 * compliant today.
 *
 * REMAINING WORK (ATL-008): self-host the Inter woff2 files and load them with
 * `next/font/local` to get Inter itself without any external request.
 */

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  // Deliberately factual. Marketing copy is reviewed against the honesty rules in
  // docs/01-product-requirements.md before it appears anywhere.
  description: "Understand and manage the personal information connected to your digital life.",
  robots: { index: false, follow: false }, // opened deliberately at launch
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never block zoom: users must be able to reach 200% (accessibility skill).
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a
          href="#main"
          className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-4 focus-visible:left-4 focus-visible:z-50 focus-visible:rounded-control focus-visible:bg-surface-raised focus-visible:px-4 focus-visible:py-2 focus-visible:text-text-primary"
        >
          Skip to content
        </a>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
