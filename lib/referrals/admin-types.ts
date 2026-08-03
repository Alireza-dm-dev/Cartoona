export interface AdminReferralSettings {
  isEnabled: boolean;
  rewardBasisPoints: number;
  updatedAt: string;
}

export interface AdminReferralMetrics {
  totalParentProfiles: number;
  totalRelationships: number;
  totalUnboundParentProfiles: number;
  totalDeletedIdentityRelationships: number;
  settingsHistoryCount: number;
}

export interface AdminReferralRelationship {
  id: string;
  boundAt: string;
  bindingSource: string;
  referralCodeSnapshot: string;
  referredParent: {
    name: string | null;
    email: string | null;
  } | null;
  referrerParent: {
    name: string | null;
    email: string | null;
    currentCode: string | null;
  } | null;
}

export interface AdminReferralListPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminReferralListResponse {
  settings: AdminReferralSettings;
  metrics: AdminReferralMetrics;
  relationships: AdminReferralRelationship[];
  pagination: AdminReferralListPagination;
}

export interface AdminReferralSettingsUpdateRequest {
  isEnabled: boolean;
  rewardBasisPoints: number;
  expectedUpdatedAt: string;
}

export interface AdminReferralSettingsUpdateResponse {
  status: "updated" | "unchanged";
  settings: AdminReferralSettings;
}

export type AdminReferralApiErrorCode =
  | "REFERRAL_SETTINGS_CONFLICT"
  | "REFERRAL_SETTINGS_INVALID";

export interface AdminReferralErrorResponse {
  error: string;
  code: AdminReferralApiErrorCode;
}
