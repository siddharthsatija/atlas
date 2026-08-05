import { cn } from "@/lib/utils";

/**
 * Layout primitives — spacing and width only.
 *
 * This is NOT the product shell. The sidebar, top bar, and content region belong to
 * the (product) route group layout and are owned by ATL-005; the mobile drawer is
 * ATL-007. These primitives exist so those tickets have consistent containers to
 * build on.
 *
 * Max content width ~1440px with comfortable gutters (frontend spec §2).
 */
function PageContainer({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-container"
      /**
       * `max-w-(--container-content)`, with parentheses.
       *
       * Tailwind v3 auto-wrapped a bracketed value starting with `--` in
       * `var()`. v4 does not: `max-w-[--container-content]` compiles to the
       * literal `max-width: --container-content`, which is invalid CSS, so the
       * browser drops the declaration and the container grows unbounded. It fails
       * silently — the class is present in the markup and a rule is present in the
       * stylesheet, so nothing looks wrong until you measure the box.
       */
      className={cn("mx-auto w-full max-w-(--container-content) px-4 sm:px-6 lg:px-8", className)}
      {...props}
    />
  );
}

/**
 * Page heading region. Exactly one <h1> per page, and it is the focus target on
 * route change (accessibility skill).
 *
 * Rendered as a `div`, not a `header`: inside the shell this sits within `<main>`,
 * where HTML-AAM gives `<header>` no landmark role — but tooling disagrees
 * (testing-library resolves it as a second `banner` while axe does not). A `div`
 * removes the ambiguity entirely, and this region is a visual grouping rather than
 * a landmark. The page banner is the top bar (ATL-005).
 */
function PageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header"
      className={cn("flex flex-col gap-2 pt-8 pb-6", className)}
      {...props}
    />
  );
}

function PageTitle({ className, children, ...props }: React.ComponentProps<"h1">) {
  // `children` destructured explicitly so jsx-a11y can verify heading content.
  return (
    <h1 data-slot="page-title" className={cn("text-h1 font-semibold", className)} {...props}>
      {children}
    </h1>
  );
}

function PageDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="page-description"
      className={cn("text-body text-text-secondary", className)}
      {...props}
    />
  );
}

/**
 * Main landmark for pages rendered OUTSIDE the product shell.
 *
 * Inside `(product)`, `AppShell` already provides `<main id="main">` (ATL-005), so
 * product pages compose `PageContainer` / `PageHeader` / `PageTitle` instead —
 * using this there would create a second `main` landmark.
 */
function PageContent({ className, ...props }: React.ComponentProps<"main">) {
  return <main id="main" data-slot="page-content" className={cn("pb-16", className)} {...props} />;
}

/** Vertical rhythm helper using the 4px spacing scale (design system §4). */
function Stack({
  className,
  gap = "md",
  ...props
}: React.ComponentProps<"div"> & { gap?: "sm" | "md" | "lg" }) {
  return (
    <div
      data-slot="stack"
      className={cn(
        "flex flex-col",
        gap === "sm" && "gap-3",
        gap === "md" && "gap-6",
        gap === "lg" && "gap-10",
        className,
      )}
      {...props}
    />
  );
}

export { PageContainer, PageHeader, PageTitle, PageDescription, PageContent, Stack };
