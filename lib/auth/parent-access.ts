export type ParentAccessResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "unauthenticated"
        | "wrong_role"
        | "consent_required"
        | "lookup_failed";
    };

export function isParentRole(role: string | null | undefined): boolean {
  return role === "parent"
}
