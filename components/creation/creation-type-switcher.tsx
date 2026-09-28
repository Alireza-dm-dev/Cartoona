import Link from "next/link";

type CreationType = "image" | "video" | "drawing";

interface CreationTypeSwitcherProps {
  activeType: CreationType;
}

const items: { type: CreationType; label: string; href: string }[] = [
  { type: "image", label: "تصویر کارتونی", href: "/create-image" },
  { type: "video", label: "ویدیوی کارتونی", href: "/request-video" },
  { type: "drawing", label: "متحرک‌سازی نقاشی", href: "/animate-drawing" },
];

export function CreationTypeSwitcher({ activeType }: CreationTypeSwitcherProps) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      {items.map((item) => {
        const isActive = item.type === activeType;
        return (
          <Link
            key={item.type}
            href={isActive ? "#" : item.href}
            aria-current={isActive ? "page" : undefined}
            className={`min-h-[44px] rounded-xl p-4 text-center text-sm font-medium transition-all ${
              isActive
                ? "neu-pressed-pink font-semibold"
                : "neu-raised neu-interactive text-text-dark/60 hover:text-text-dark"
            }`}
          >
            <span>{item.label}</span>
            {isActive && (
              <span className="block mt-1 text-[11px] text-candy-pink">
                در حال ساخت
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
