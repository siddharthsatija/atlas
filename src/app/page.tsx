import { APP_NAME } from "@/config/app";

/**
 * Foundation placeholder.
 *
 * Exists so the application compiles and the end-to-end harness has a route to
 * verify. This is not a product screen: the marketing page belongs to the (public)
 * route group and the dashboard to (product)/overview (ATL-019 onward).
 *
 * Replace when the first real route lands. Do not grow this file.
 */
export default function FoundationPage() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-h1 font-semibold">{APP_NAME}</h1>
      <p className="text-text-secondary">
        Project foundation. No product functionality is implemented yet.
      </p>
      <p className="text-body-sm text-text-muted">
        Implementation sequence: <code>.claude/implementation-order.md</code>. Engineering workflow:{" "}
        <code>.claude/workflow.md</code>.
      </p>
    </main>
  );
}
