import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Card — design system §10.
 *
 * Cards deliberately do not all look identical: weight reflects importance and
 * actionability. `padding` and `radius` are separate knobs so a prominent panel
 * (the score card) can differ from a supporting metric card.
 *
 * Elevation preference: border and tonal contrast before shadow (design system §6).
 */
const cardVariants = cva("bg-surface border border-border-default", {
  variants: {
    padding: {
      compact: "p-4", // 16
      standard: "p-5", // 20
      prominent: "p-8", // 32
      none: "",
    },
    radius: {
      card: "rounded-card",
      panel: "rounded-panel",
    },
    elevation: {
      flat: "",
      raised: "shadow-[--shadow-level-1]",
    },
  },
  defaultVariants: { padding: "standard", radius: "card", elevation: "flat" },
});

export interface CardProps extends React.ComponentProps<"div">, VariantProps<typeof cardVariants> {}

function Card({ className, padding, radius, elevation, ...props }: CardProps) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ padding, radius, elevation }), className)}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

function CardTitle({ className, children, ...props }: React.ComponentProps<"h3">) {
  // `children` is destructured explicitly so jsx-a11y can verify the heading has
  // content; spreading it implicitly defeats that static check.
  return (
    <h3 data-slot="card-title" className={cn("text-h3 font-semibold", className)} {...props}>
      {children}
    </h3>
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-body-sm text-text-secondary", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("mt-4", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("mt-4 flex items-center gap-2", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, cardVariants };
