const PERSIAN_DIGITS: Record<string, string> = {
  "0": "۰",
  "1": "۱",
  "2": "۲",
  "3": "۳",
  "4": "۴",
  "5": "۵",
  "6": "۶",
  "7": "۷",
  "8": "۸",
  "9": "۹",
};

function toPersianDigits(value: number, grouped: boolean): string {
  const raw = grouped
    ? value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : value.toString();
  return raw
    .split("")
    .map((c) => PERSIAN_DIGITS[c] || c)
    .join("");
}

export function formatPriceToman(priceToman: number | null): string {
  if (priceToman === null) return "براساس درخواست";
  return `${toPersianDigits(priceToman, true)} تومان`;
}

export function formatCandies(candies: number | null): string {
  if (candies === null) return "براساس پروژه";
  return `${toPersianDigits(candies, false)} آب‌نبات`;
}
