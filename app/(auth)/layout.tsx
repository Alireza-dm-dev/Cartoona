import { AppBackground } from "@/components/ui/app-background";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-full items-center justify-center p-6">
      <AppBackground />
      <div className="relative z-10 w-full max-w-md">{children}</div>
    </div>
  );
}
