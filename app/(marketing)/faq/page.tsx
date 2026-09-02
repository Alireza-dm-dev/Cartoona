import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { faqs } from "@/config/faqs";

export default function FAQPage() {
  return (
    <div className="mx-auto max-w-[800px] px-6 py-16">
      <PageHeader
        title="سوالات متداول"
        description="پاسخ سوال‌های رایج والدین درباره ساخت کارتون‌های اختصاصی، آبنبات‌ها، حریم خصوصی و روند سفارش در کارتونا."
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
