import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { characters } from "@/config/characters";

const persianNames: Record<string, string> = {
  "Captain Candy": "کاپیتان آبنبات",
  "Princess Luma": "پرنسس لوما",
  "Dino Dodo": "داینو دودو",
  "Robo Bobo": "روبو بوبو",
  "Fairy Nila": "پری نیلا",
  "Professor Panda": "پروفسور پاندا",
  "Mimi the Magic Cat": "میمی گربه جادویی",
  "Leo the Brave Lion": "لئو شیر شجاع",
  "Sunny Space Explorer": "سانی کاوشگر فضا",
  "Wally the Wizard": "والی جادوگر",
};

const persianCategories: Record<string, string> = {
  Adventure: "ماجراجویی",
  Fantasy: "خیالی",
  Animals: "حیوانات",
  "Sci-Fi": "علمی-تخیلی",
  Education: "آموزشی",
};

const persianDescriptions: Record<string, string> = {
  "Captain Candy":
    "یک کاوشگر فضایی شجاع که در کهکشان‌های پر از آبنبات سفر می‌کند.",
  "Princess Luma":
    "یک پرنسس مهربان که نور و محبت را به اطرافیانش هدیه می‌دهد.",
  "Dino Dodo":
    "یک دایناسور کوچولو و سرحال که عاشق دوست‌یابی است.",
  "Robo Bobo":
    "یک ربات کنجکاو که عاشق اختراع و ساختن چیزهای جدید است.",
  "Fairy Nila":
    "یک پری جادویی که با یک مشت ستاره آرزوها را برآورده می‌کند.",
  "Professor Panda":
    "یک معلم پاندای دانا که یادگیری را شیرین و هیجان‌انگیز می‌کند.",
  "Mimi the Magic Cat":
    "یک گربه بازیگوش با قدرت‌های جادویی که عاشق ماجراجویی است.",
  "Leo the Brave Lion":
    "یک شیر شجاع و مهربان که از دوستانش با تمام وجود محافظت می‌کند.",
  "Sunny Space Explorer":
    "یک فضانورد پرشور که دنیاهای جدید کشف می‌کند.",
  "Wally the Wizard":
    "یک جادوگر خوش‌برخورد که معجون‌های جادویی و طلسم‌های بامزه درست می‌کند.",
};

export default function CharactersPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-16">
      <PageHeader
        title="شخصیت‌های کارتونا"
        description="شخصیت‌های اصلی و اختصاصی کارتونا برای ساخت خاطره‌های کارتونی امن، گرم و خانوادگی طراحی شده‌اند."
      />
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {characters.map((character) => (
          <Card key={character.name}>
            <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-cream text-2xl">
              {character.emoji}
            </div>
            <h3 className="font-semibold text-text-dark">
              {persianNames[character.name] ?? character.name}
            </h3>
            <p className="mt-1 text-sm text-text-dark/60">
              {persianDescriptions[character.name] ?? character.description}
            </p>
            <span className="mt-3 inline-block rounded-full bg-soft-purple/10 px-3 py-0.5 text-xs text-soft-purple">
              {persianCategories[character.category] ?? character.category}
            </span>
          </Card>
        ))}
      </div>
    </div>
  );
}
