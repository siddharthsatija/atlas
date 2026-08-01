import { cn } from "@/lib/utils";

/**
 * Table — real table semantics (design system §13, accessibility skill).
 *
 * Constraints from the specifications:
 *  - Dense enterprise tables are never the default. Card grids come first
 *    (frontend spec §6); tables are for comparing many records across the same fields.
 *  - On mobile, tables become cards. Horizontal scroll only when unavoidable, and the
 *    scroll container must be keyboard focusable so it can be scrolled without a pointer.
 *  - Every table needs an accessible name: pass `caption` or aria-label on <Table>.
 *  - Row actions must be reachable by keyboard and via a touch overflow menu.
 *  - Show masked values only — never an unmasked identifier or recipient in a list.
 */
function Table({
  className,
  caption,
  ...props
}: React.ComponentProps<"table"> & { caption?: string }) {
  return (
    <div
      data-slot="table-container"
      /**
       * DOCUMENTED EXCEPTION: jsx-a11y/no-noninteractive-tabindex.
       * A scrollable region must be keyboard operable (WCAG 2.1.1); axe enforces
       * this with `scrollable-region-focusable`, which fails without tabIndex={0}.
       * The two lint rules genuinely conflict and the accessibility requirement wins.
       */
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="region"
      aria-label={caption}
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom border-collapse text-body-sm", className)}
        {...props}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {props.children}
      </table>
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border-default hover:bg-surface-subtle",
        "transition-colors duration-[--duration-standard]",
        className,
      )}
      {...props}
    />
  );
}

/** Always pass `scope` ("col" or "row") so the header association is unambiguous. */
function TableHead({ className, scope = "col", ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn("h-10 px-3 text-left text-label font-medium text-text-secondary", className)}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td data-slot="table-cell" className={cn("px-3 py-3 align-middle", className)} {...props} />
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
