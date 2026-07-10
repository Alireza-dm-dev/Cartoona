interface SectionShellProps {
  children: React.ReactNode;
  className?: string;
}

export function SectionShell({ children, className = "" }: SectionShellProps) {
  return (
    <section className={`py-16 md:py-24 ${className}`}>{children}</section>
  );
}
