import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import type { ReactNode } from "react";

export type StatusBadgeVariant = "success" | "error" | "warning" | "neutral";

const variantClasses: Record<StatusBadgeVariant, string> = {
  success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  error: "border-red-500/20 bg-red-500/10 text-red-400",
  warning: "border-amber-500/20 bg-amber-500/10 text-amber-400",
  neutral: "border-border bg-muted text-muted-foreground",
};

const dotClasses: Record<StatusBadgeVariant, string> = {
  success: "bg-emerald-400",
  error: "bg-red-400",
  warning: "bg-amber-400",
  neutral: "bg-muted-foreground",
};

export function StatusBadge({
  children,
  className,
  dot = false,
  variant,
}: {
  children: ReactNode;
  className?: string;
  dot?: boolean;
  variant: StatusBadgeVariant;
}) {
  return (
    <Badge
      className={cn("border font-medium", variantClasses[variant], className)}
      variant="outline"
    >
      {dot ? (
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotClasses[variant])} />
      ) : null}
      {children}
    </Badge>
  );
}
