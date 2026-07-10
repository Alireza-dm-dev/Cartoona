import { Card } from "./card";

interface SafetyNoticeProps {
  title?: string;
  children: React.ReactNode;
}

export function SafetyNotice({
  title = "Safety & Privacy",
  children,
}: SafetyNoticeProps) {
  return (
    <Card variant="admin" className="border-sky-blue/30 bg-sky-blue/5">
      <div className="flex items-start gap-3">
        <span className="text-xl" aria-hidden="true">🛡️</span>
        <div>
          <h3 className="font-semibold text-parent-navy">{title}</h3>
          <div className="mt-1 text-sm text-text-dark/70">{children}</div>
        </div>
      </div>
    </Card>
  );
}
