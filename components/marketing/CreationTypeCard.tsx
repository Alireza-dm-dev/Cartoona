import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface CreationTypeCardProps {
  badge: string;
  badgeVariant: "default" | "info" | "success";
  title: string;
  description: string;
  cta: string;
  href: string;
  media:
    | { type: "image"; src: string }
    | { type: "video"; src: string };
}

export function CreationTypeCard({
  badge,
  badgeVariant,
  title,
  description,
  cta,
  href,
  media,
}: CreationTypeCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-[24px] border border-white/70 bg-white/60 p-4 shadow-[0_14px_36px_rgba(90,120,150,0.16)] backdrop-blur-xl transition-all hover:-translate-y-1 hover:shadow-[0_22px_46px_rgba(242,100,154,0.22)]">
      <div className="aspect-video overflow-hidden rounded-2xl border border-white/70 bg-white/45">
        {media.type === "video" ? (
          <video
            src={media.src}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : (
          <img src={media.src} alt={title} className="h-full w-full object-cover" />
        )}
      </div>
      <div className="flex items-start justify-between gap-3 px-1">
        <Badge variant={badgeVariant}>{badge}</Badge>
      </div>
      <h3 className="px-1 text-lg font-extrabold tracking-tight text-parent-navy">{title}</h3>
      <p className="px-1 text-sm leading-relaxed text-text-dark/60">{description}</p>
      <div className="mt-1 px-1">
        <Link href={href}>
          <Button>{cta}</Button>
        </Link>
      </div>
    </div>
  );
}
