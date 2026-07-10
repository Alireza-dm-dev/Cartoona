import { Badge } from "./badge";

interface CandyBalanceBadgeProps {
  balance?: number;
}

export function CandyBalanceBadge({ balance }: CandyBalanceBadgeProps) {
  const displayBalance = balance ?? 0;

  return (
    <Badge variant="warning">
      <span className="mr-1" aria-hidden="true">🍬</span>
      {displayBalance} candies
    </Badge>
  );
}
