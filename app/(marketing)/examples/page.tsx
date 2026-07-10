import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { SafetyNotice } from "@/components/ui/safety-notice";

const examples = [
  { title: "Captain Candy Space Adventure", description: "A colorful space scene featuring Captain Candy exploring a candy-filled galaxy." },
  { title: "Princess Luma Storybook", description: "A gentle storybook-style illustration of Princess Luma in her enchanted garden." },
  { title: "Dino Dodo Animal Friends", description: "Dino Dodo making new friends in a bright, playful jungle setting." },
  { title: "Robo Bobo Builds a Robot", description: "Robo Bobo assembling a friendly helper robot in a whimsical workshop." },
];

export default function ExamplesPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-16">
      <PageHeader
        title="Example Creations"
        description="Safe, fictional examples showing what Cartoona can create for your family."
      />
      <div className="grid gap-6 sm:grid-cols-2">
        {examples.map((example) => (
          <Card key={example.title}>
            <div className="mb-3 aspect-video rounded-2xl bg-cream flex items-center justify-center text-text-dark/30 text-sm">
              [Example illustration placeholder]
            </div>
            <h3 className="font-semibold text-text-dark">{example.title}</h3>
            <p className="mt-1 text-sm text-text-dark/60">{example.description}</p>
          </Card>
        ))}
      </div>
      <div className="mt-8">
        <SafetyNotice>
          All examples shown are fictional and created in a controlled environment.
          Your family&apos;s creations remain private by default.
        </SafetyNotice>
      </div>
    </div>
  );
}
