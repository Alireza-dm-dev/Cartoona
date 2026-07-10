import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionShell } from "@/components/ui/section-shell";

export default function HomePage() {
  return (
    <>
      <SectionShell className="flex flex-col items-center text-center">
        <span className="mb-4 inline-block text-6xl" aria-hidden="true">🎨</span>
        <h1 className="max-w-2xl text-4xl font-bold text-parent-navy md:text-5xl">
          Turn your child&apos;s imagination into beautiful cartoons
        </h1>
        <p className="mt-4 max-w-xl text-lg text-text-dark/70">
          A safe, parent-controlled platform for creating personalized cartoon images,
          videos, and animations — featuring original characters your kids will love.
        </p>
        <div className="mt-8 flex gap-4">
          <Link href="/signup">
            <Button size="lg">Start Creating</Button>
          </Link>
          <Link href="/examples">
            <Button variant="secondary" size="lg">See Examples</Button>
          </Link>
        </div>
        <p className="mt-6 text-sm text-text-dark/50">
          🛡️ Parent-controlled · Private by default · No social features
        </p>
      </SectionShell>

      <SectionShell className="bg-white">
        <div className="mx-auto max-w-[1200px] px-6">
          <h2 className="mb-12 text-center text-2xl font-bold text-parent-navy">
            How it works
          </h2>
          <div className="grid gap-6 md:grid-cols-3">
            <Card>
              <div className="mb-3 text-3xl" aria-hidden="true">1️⃣</div>
              <h3 className="font-semibold text-text-dark">Choose & Request</h3>
              <p className="mt-2 text-sm text-text-dark/60">
                Pick original characters, themes, and describe what you want.
              </p>
            </Card>
            <Card>
              <div className="mb-3 text-3xl" aria-hidden="true">2️⃣</div>
              <h3 className="font-semibold text-text-dark">We Create</h3>
              <p className="mt-2 text-sm text-text-dark/60">
                Our team reviews and fulfills each request with care and safety.
              </p>
            </Card>
            <Card>
              <div className="mb-3 text-3xl" aria-hidden="true">3️⃣</div>
              <h3 className="font-semibold text-text-dark">Download & Enjoy</h3>
              <p className="mt-2 text-sm text-text-dark/60">
                Private delivery — only your family sees the finished cartoons.
              </p>
            </Card>
          </div>
        </div>
      </SectionShell>

      <SectionShell className="text-center">
        <h2 className="text-2xl font-bold text-parent-navy">
          Built by parents, for parents
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-text-dark/70">
          You stay in control. Every upload, request, and download is managed by you.
          No child accounts. No public sharing. No surprises.
        </p>
      </SectionShell>
    </>
  );
}
