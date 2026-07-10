export interface Plan {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  candyAmount: number;
  isPopular?: boolean;
}

/**
 * TODO: Finalize plan structure — pay-per-creation, candy packs, or prepaid bundles.
 * These are placeholder values and will change before MVP launch.
 */
export const plans: Plan[] = [];
