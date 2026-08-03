import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function AdminRequestNotFound() {
  return (
    <div className="mx-auto max-w-[960px]">
      <div className="flex flex-col items-center rounded-xl border border-soft-border bg-white p-12 text-center">
        <p className="text-lg font-semibold text-text-dark">درخواست یافت نشد</p>
        <p className="mt-2 max-w-md text-sm text-text-dark/60">
          درخواست موردنظر در دسترس نیست یا حذف شده است.
        </p>
        <div className="mt-6">
          <Link href="/admin/requests">
            <Button variant="secondary">بازگشت به صف درخواست‌ها</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
