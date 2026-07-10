import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";

const faqs = [
  { q: "Is Cartoona safe for my child?", a: "Yes. Cartoona is a parent-controlled platform. Only parents can create accounts, upload content, and manage requests. All content is reviewed before delivery. There are no social features, public galleries, or child-owned accounts." },
  { q: "How does the Candy system work?", a: "Candies are Cartoona's credit system. You purchase candy packs and spend them on creations. No subscriptions, no hidden fees." },
  { q: "Can my child use Cartoona independently?", a: "No. Cartoona is designed for parents to control the experience. Children can help choose characters and themes, but all actions require a parent account." },
  { q: "What kind of content can I create?", a: "You can request cartoon images, videos, and drawing animations featuring our original characters. All content is reviewed for safety." },
  { q: "How long does a request take?", a: "Review and fulfillment times vary. Simple image requests may be faster, while video and animation requests require more time." },
  { q: "What happens to my data if I delete my account?", a: "All associated data — including uploaded drawings, generated content, and profile information — is permanently deleted." },
  { q: "Do you use famous characters like Disney or Marvel?", a: "No. Cartoona features only our original character universe. We do not offer famous or licensed characters." },
  { q: "Can I share my creations publicly?", a: "Not in the current version. All creations are private to your family. Public sharing features may be considered in the future with strict parent opt-in controls." },
];

export default function FAQPage() {
  return (
    <div className="mx-auto max-w-[800px] px-6 py-16">
      <PageHeader
        title="Frequently Asked Questions"
        description="Everything you need to know about Cartoona."
      />
      <div className="flex flex-col gap-4">
        {faqs.map((faq) => (
          <Card key={faq.q} variant="admin">
            <h3 className="font-semibold text-parent-navy">{faq.q}</h3>
            <p className="mt-2 text-sm text-text-dark/60">{faq.a}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
