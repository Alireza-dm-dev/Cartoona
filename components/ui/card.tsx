interface CardProps {
  children: React.ReactNode;
  className?: string;
  variant?: "playful" | "admin";
}

export function Card({ children, className = "", variant = "playful" }: CardProps) {
  const radius = variant === "admin" ? "rounded-xl" : "rounded-[24px]";
  return (
    <div
      className={`border border-soft-border bg-white ${radius} p-6 ${className}`}
    >
      {children}
    </div>
  );
}
