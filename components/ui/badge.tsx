interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
}

const variantClasses: Record<string, string> = {
  default: "bg-soft-border text-text-dark",
  success: "bg-mint-green/20 text-mint-green",
  warning: "bg-sunshine-yellow/30 text-parent-navy",
  danger: "bg-coral/20 text-coral",
  info: "bg-sky-blue/20 text-sky-blue",
};

export function Badge({ children, variant = "default", className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-0.5 text-xs font-medium ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
