import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Spinner — inline loading affordance only.
 *
 * Never use this for page-level loading: pages use structural skeletons that
 * resemble the final layout (frontend spec §18). Indefinite page spinners are
 * prohibited.
 */
export function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      aria-hidden="true"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}
