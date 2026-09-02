interface TestimonialCardProps {
  quote: string;
  name: string;
  role: string;
  tint: string;
}

export function TestimonialCard({ quote, name, role, tint }: TestimonialCardProps) {
  return (
    <div className="flex flex-col gap-5 rounded-[24px] border border-white/60 bg-white/45 p-6 shadow-[0_14px_34px_rgba(90,120,150,0.14)] backdrop-blur-xl">
      <p className="text-[15px] leading-loose text-[#33405a] text-pretty">{quote}</p>
      <div className="mt-auto flex items-center gap-3">
        <span
          className="h-[42px] w-[42px] shrink-0 rounded-full"
          style={{ background: tint }}
          aria-hidden="true"
        />
        <div className="flex flex-col">
          <strong className="text-sm font-bold text-parent-navy">{name}</strong>
          <span className="text-xs text-text-dark/50">{role}</span>
        </div>
      </div>
    </div>
  );
}
