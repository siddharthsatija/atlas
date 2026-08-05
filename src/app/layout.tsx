import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { AppProviders } from "@/providers";
import { APP_NAME } from "@/config/app";
import { CSP_NONCE_HEADER } from "@/lib/security/content-security-policy";
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /**
   * The per-request CSP nonce from middleware (ATL-087).
   *
   * Next stamps its own streamed bootstrap scripts automatically, but an inline
   * script rendered by a *library* is invisible to that mechanism. `next-themes`
   * emits one — the snippet that applies the stored theme before first paint —
   * and without a nonce the policy blocks it, producing a light-mode flash on
   * every load plus a violation report on every page.
   *
   * Reading it here rather than in the provider keeps `theme-provider.tsx` a
   * client component: `headers()` is server-only.
   */
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a
          href="#main"
          className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-4 focus-visible:left-4 focus-visible:z-50 focus-visible:rounded-control focus-visible:bg-surface-raised focus-visible:px-4 focus-visible:py-2 focus-visible:text-text-primary"
        >
          Skip to content
        </a>
        <AppProviders nonce={nonce}>{children}</AppProviders>
      </body>
    </html>
  );
}
