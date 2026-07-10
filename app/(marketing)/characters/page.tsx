import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { characters } from "@/config/characters";

export default function CharactersPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-16">
      <PageHeader
        title="Meet the Characters"
        description="Our original cast of cartoon characters — each one designed to spark creativity and bring smiles."
      />
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {characters.map((character) => (
          <Card key={character.name}>
            <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-cream text-2xl">
              {character.emoji}
            </div>
            <h3 className="font-semibold text-text-dark">{character.name}</h3>
            <p className="mt-1 text-sm text-text-dark/60">{character.description}</p>
            <span className="mt-3 inline-block rounded-full bg-soft-purple/10 px-3 py-0.5 text-xs text-soft-purple">
              {character.category}
            </span>
          </Card>
        ))}
      </div>
    </div>
  );
}
