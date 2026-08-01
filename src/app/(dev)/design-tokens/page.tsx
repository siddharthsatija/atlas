import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { COLOR_ROLES } from "@/config/design-tokens";
import {
  PageContainer,
  PageContent,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@/components/layout/page-layout";

/**
 * Design token sheet (ATL-008).
 *
 * The reference surface for the visual snapshot required by this ticket: every
 * semantic role, type step, radius tier, elevation level, and motion duration
 * rendered from the live tokens, so a regression is visible rather than inferred.
 *
 * Not a product surface. It returns 404 in production so it never ships to users,
 * and it renders no data.
 *
 * Swatches deliberately use inline `var(--color-*)` references rather than utility
 * classes: this sheet must display the *token values themselves*, including any
 * role that no component happens to use yet.
 */

export const metadata: Metadata = { title: "Design tokens", robots: { index: false } };

/**
 * Rendered per request, not prerendered.
 *
 * Without this the production guard below would be evaluated at BUILD time — and a
 * build runs with the build environment's variables, so the statically generated
 * page would be served in production regardless. Verified: with static rendering
 * this route returned HTTP 200 under `ATLAS_ENV=production`.
 */
export const dynamic = "force-dynamic";

const TYPE_STEPS = [
  "display",
  "h1",
  "h2",
  "h3",
  "body-lg",
  "body",
  "body-sm",
  "label",
  "caption",
] as const;

const RADIUS_TIERS = ["control", "input", "card", "panel", "modal"] as const;
const ELEVATIONS = ["level-1", "level-2", "level-3"] as const;
const TONES = ["accent", "success", "warning", "danger", "info"] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border-default py-8">
      <h2 className="mb-4 text-h3 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function DesignTokensPage() {
  // Never expose an internal reference surface in production.
  if (process.env.ATLAS_ENV === "production") notFound();

  return (
    // Outside the product shell, so this page owns the `main` landmark the root
    // layout's skip link targets.
    <PageContent>
      <PageContainer>
        <PageHeader>
          <PageTitle>Design tokens</PageTitle>
          <PageDescription>
            Every semantic token rendered from the live stylesheet. Contrast is verified
            programmatically in <code>src/styles/contrast.test.ts</code>.
          </PageDescription>
        </PageHeader>

        <Section title="Semantic colour roles">
          <ul data-testid="color-roles" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {COLOR_ROLES.map((role) => (
              <li key={role} className="rounded-card border border-border-default p-3">
                <span
                  aria-hidden="true"
                  data-swatch={role}
                  className="block h-12 w-full rounded-control border border-border-default"
                  style={{ background: `var(--color-${role})` }}
                />
                <span className="mt-2 block font-mono text-label text-text-secondary">{role}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Tone on tint (badge pattern)">
          <ul className="flex flex-wrap gap-2">
            {TONES.map((tone) => (
              <li
                key={tone}
                className="rounded-full px-3 py-1 text-label font-medium"
                style={{
                  color: `var(--color-${tone})`,
                  background: `color-mix(in srgb, var(--color-${tone}) 10%, var(--color-surface))`,
                }}
              >
                {tone}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Solid fills">
          <div className="flex flex-wrap gap-3">
            <span
              className="rounded-input px-4 py-2 text-body-sm font-medium"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-foreground)" }}
            >
              Accent fill
            </span>
            <span
              className="rounded-input px-4 py-2 text-body-sm font-medium"
              style={{ background: "var(--color-danger)", color: "var(--color-danger-foreground)" }}
            >
              Danger fill
            </span>
          </div>
        </Section>

        <Section title="Typography">
          <ul className="flex flex-col gap-2">
            {TYPE_STEPS.map((step) => (
              <li key={step} className="flex items-baseline gap-4">
                <span className="w-24 shrink-0 font-mono text-caption text-text-muted">{step}</span>
                <span style={{ fontSize: `var(--text-${step})` }}>
                  The quick brown fox — 0123456789
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Radius tiers">
          <ul className="flex flex-wrap gap-4">
            {RADIUS_TIERS.map((tier) => (
              <li key={tier} className="flex flex-col items-center gap-2">
                <span
                  aria-hidden="true"
                  className="block size-20 border border-border-strong bg-surface-subtle"
                  style={{ borderRadius: `var(--radius-${tier})` }}
                />
                <span className="font-mono text-caption text-text-muted">{tier}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Elevation">
          <ul className="flex flex-wrap gap-6">
            {ELEVATIONS.map((level) => (
              <li key={level} className="flex flex-col items-center gap-2">
                <span
                  aria-hidden="true"
                  className="block size-20 rounded-card bg-surface-raised"
                  style={{ boxShadow: `var(--shadow-${level})` }}
                />
                <span className="font-mono text-caption text-text-muted">{level}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Motion">
          <ul className="flex flex-col gap-1 text-body-sm">
            <li>
              <span className="font-mono">--duration-standard</span> — 150–220 ms band
            </li>
            <li>
              <span className="font-mono">--duration-panel</span> — 220–300 ms band
            </li>
            <li className="text-text-secondary">
              All motion is suppressed under <code>prefers-reduced-motion: reduce</code>.
            </li>
          </ul>
        </Section>
      </PageContainer>
    </PageContent>
  );
}
