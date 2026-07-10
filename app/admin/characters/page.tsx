import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { characters } from "@/config/characters";

export default function AdminCharactersPage() {
  return (
    <div>
      <PageHeader
        title="Character Management"
        description="Manage the original Cartoona character universe."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {characters.map((character) => (
          <Card key={character.name} variant="admin">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{character.emoji}</span>
              <div>
                <h3 className="font-semibold text-text-dark">{character.name}</h3>
                <p className="text-xs text-text-dark/50">{character.category}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Add CRUD for characters. Image upload, variant management, visibility toggles.
      </p>
    </div>
  );
}
