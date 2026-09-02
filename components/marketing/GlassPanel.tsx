interface GlassPanelProps {
  children: React.ReactNode;
  className?: string;
}

export function GlassPanel({ children, className = "" }: GlassPanelProps) {
  return (
    <div
      className={`rounded-[28px] border border-white/70 bg-white/55 shadow-[0_18px_44px_rgba(90,120,150,0.16)] backdrop-blur-xl ${className}`}
    >
      {children}
    </div>
  );
}
