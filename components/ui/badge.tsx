interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
  size?: "sm" | "md";
}

const variantClasses: Record<string, string> = {
  default: "bg-soft-border text-text-dark",
  success: "bg-mint-green/20 text-mint-green",
  warning: "bg-sunshine-yellow/30 text-parent-navy",
  danger: "bg-coral/20 text-coral",
  info: "bg-sky-blue/20 text-sky-blue",
};

const sizeClasses: Record<string, string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-3 py-0.5 text-sm",
};

export function Badge({ children, variant = "default", className = "", size = "sm" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
    >
      {children}
    </span>
  );
}
