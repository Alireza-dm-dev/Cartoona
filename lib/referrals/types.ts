export interface ParentReferralSummary {
  referralCode: string;
  program: {
    isEnabled: boolean;
    rewardBasisPoints: number;
  };
  binding: {
    isBound: boolean;
    boundAt: string | null;
  };
  referredCount: number;
}

export interface ReferralBindRequest {
  code: string;
}

export interface ReferralBindSuccess {
  status: "bound" | "already_bound";
  message: string;
}

export type ReferralApiErrorCode =
  | "REFERRAL_CODE_INVALID"
  | "REFERRAL_ALREADY_BOUND"
  | "REFERRAL_PROGRAM_DISABLED"
  | "REFERRAL_RATE_LIMITED"
  | "PARENT_PROFILE_NOT_FOUND"
  | "PARENT_SESSION_EXPIRED";
