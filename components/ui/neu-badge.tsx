interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
  size?: "sm" | "md";
}

/**
 * Neumorphic sibling of components/ui/badge.tsx (softened status chips —
 * spec 4F). CreationTypeCard.tsx (homepage) keeps importing the original
 * ./badge, so the homepage's chip styling is untouched.
 */
const variantClasses: Record<string, string> = {
  default: "bg-soft-border/60 text-text-dark",
  success: "bg-mint-green/25 text-emerald-800",
  warning: "bg-sunshine-yellow/35 text-parent-navy",
  danger: "bg-coral/20 text-rose-800",
  info: "bg-sky-blue/25 text-sky-900",
};

const sizeClasses: Record<string, string> = {
  sm: "px-2.5 py-0.5 text-xs",
  md: "px-3 py-1 text-sm",
};

export function Badge({ children, variant = "default", className = "", size = "sm" }: BadgeProps) {
  return (
    <span
      className={`neu-chip inline-flex items-center font-medium ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
    >
      {children}
    </span>
  );
}
