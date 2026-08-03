export type PlanId = "starter" | "plus" | "premium" | "exclusive";

export interface CartoonaPlan {
  id: PlanId;
  name: string;
  priceToman: number | null;
  candies: number | null;
  description: string;
  benefits: string[];
  recommended?: boolean;
}

export const plans: CartoonaPlan[] = [
  {
    id: "starter",
    name: "شروع",
    priceToman: 900000,
    candies: 100,
    description: "برای شروع ساخت تصاویر و تجربه اولین ویدیوی کوتاه کارتونی",
    benefits: [
      "ساخت تصاویر کارتونی ساده",
      "امکان ترکیب تصویر و ویدیوی کوتاه",
      "مناسب برای اولین تجربه",
      "دسترسی به شخصیت‌های اصلی کارتونا",
    ],
  },
  {
    id: "plus",
    name: "پلاس",
    priceToman: 2000000,
    candies: 250,
    recommended: true,
    description: "برای خانواده‌هایی که تصاویر و ویدیوهای شخصی‌سازی‌شده بیشتری می‌خواهند",
    benefits: [
      "تصاویر کارتونی با جزئیات بیشتر",
      "چند ویدیوی کوتاه",
      "متحرک‌سازی نقاشی",
      "امکان ثبت درخواست‌های متنوع",
    ],
  },
  {
    id: "premium",
    name: "حرفه‌ای",
    priceToman: 4000000,
    candies: 560,
    description: "برای ساخت پروژه‌های باکیفیت‌تر، چند صحنه و تعداد درخواست بیشتر",
    benefits: [
      "تصاویر با جزئیات و کیفیت بالاتر",
      "ویدیوهای بیشتر یا طولانی‌تر",
      "پروژه‌های چندصحنه‌ای",
      "بررسی و کنترل کیفی بیشتر",
    ],
  },
  {
    id: "exclusive",
    name: "اختصاصی",
    priceToman: null,
    candies: null,
    description: "برای داستان‌ها، شخصیت‌ها و پروژه‌هایی که به برنامه‌ریزی اختصاصی نیاز دارند",
    benefits: [
      "تعداد صحنه و مدت سفارشی",
      "چند شخصیت در یک پروژه",
      "طراحی و هماهنگی اختصاصی",
      "قیمت و آب‌نبات براساس درخواست",
    ],
  },
];
