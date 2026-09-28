interface CardProps {
  children: React.ReactNode;
  className?: string;
  variant?: "playful" | "admin";
}

/**
 * Shared neumorphic raised surface for cards/panels across every
 * non-homepage page (this component is never imported by the homepage
 * or any component it renders). "admin" keeps a tighter radius/padding
 * for denser operational screens; "playful" is the default softer card
 * used across public/auth/creation/dashboard pages.
 */
export function Card({ children, className = "", variant = "playful" }: CardProps) {
  const radius = variant === "admin" ? "rounded-2xl" : "rounded-[24px]";
  const padding = variant === "admin" ? "p-5" : "p-6";
  return (
    <div className={`neu-raised ${radius} ${padding} ${className}`}>
      {children}
    </div>
  );
}
