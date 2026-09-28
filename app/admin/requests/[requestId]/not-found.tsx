import Link from "next/link";
import { Button } from "@/components/ui/neu-button";
import { EmptyState } from "@/components/ui/empty-state";

export default function AdminRequestNotFound() {
  return (
    <div className="mx-auto max-w-[960px]">
      <EmptyState
        title="درخواست یافت نشد"
        description="درخواست موردنظر در دسترس نیست یا حذف شده است."
        action={
          <Link href="/admin/requests">
            <Button variant="secondary">بازگشت به صف درخواست‌ها</Button>
          </Link>
        }
      />
    </div>
  );
}
