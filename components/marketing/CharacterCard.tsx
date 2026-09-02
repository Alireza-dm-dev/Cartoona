interface CharacterCardProps {
  emoji: string;
  name: string;
  age: string;
  description: string;
  tint: string;
}

export function CharacterCard({ emoji, name, age, description, tint }: CharacterCardProps) {
  return (
    <div className="flex flex-col gap-3.5 rounded-[22px] border border-white/70 bg-white/58 p-4 shadow-[0_14px_34px_rgba(90,120,150,0.16)] backdrop-blur-xl transition-shadow hover:shadow-[0_16px_34px_rgba(242,100,154,0.2)]">
      <div
        className="flex aspect-square items-center justify-center rounded-2xl text-5xl"
        style={{ background: tint }}
        aria-hidden="true"
      >
        {emoji}
      </div>
      <div className="flex flex-col gap-1.5 px-1 pb-1">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-base font-bold text-parent-navy">{name}</strong>
          <span className="rounded-full bg-soft-border/60 px-2.5 py-1 text-xs font-bold text-text-dark/70">
            {age}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-text-dark/60">{description}</p>
      </div>
    </div>
  );
}
