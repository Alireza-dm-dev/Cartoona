import { type ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "selected";
  size?: "sm" | "md" | "lg";
}

/**
 * Neumorphic sibling of components/ui/button.tsx, for every surface that
 * is not the homepage (Hero.tsx, FinalCtaSection.tsx and CreationTypeCard.tsx
 * keep importing the original ./button so the homepage stays pixel-identical).
 * Same prop API, so call sites only change their import path.
 */
const variantClasses: Record<string, string> = {
  primary: "neu-cta neu-interactive text-white",
  secondary: "neu-raised neu-interactive text-text-dark",
  ghost: "text-text-dark hover:bg-white/40 rounded-xl",
  danger: "neu-raised neu-interactive text-white bg-coral border-coral/40",
  selected: "neu-pressed-pink font-semibold",
};

const sizeClasses: Record<string, string> = {
  sm: "min-h-[36px] px-3 py-1.5 text-xs rounded-lg",
  md: "min-h-[44px] px-5 py-2.5 text-sm rounded-xl",
  lg: "min-h-[48px] px-6 py-3 text-base rounded-xl",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center font-medium transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candy-pink disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    />
  );
}
