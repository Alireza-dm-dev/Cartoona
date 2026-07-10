export interface ModerationCategory {
  id: string;
  label: string;
  description: string;
  autoFlag: boolean;
}

/**
 * Safety categories for content moderation.
 * TODO: Refine categories and add auto-moderation rules.
 */
export const moderationCategories: ModerationCategory[] = [
  { id: "inappropriate_content", label: "Inappropriate Content", description: "Content not suitable for children.", autoFlag: true },
  { id: "personal_info", label: "Personal Information", description: "Exposed personal data of a child or parent.", autoFlag: true },
  { id: "famous_character", label: "Famous Character", description: "Uses licensed or trademarked characters.", autoFlag: true },
  { id: "unsafe_prompt", label: "Unsafe Prompt", description: "Prompt contains harmful or unsafe instructions.", autoFlag: true },
  { id: "consent_issue", label: "Consent Issue", description: "Missing or unclear parent consent.", autoFlag: false },
  { id: "upload_concern", label: "Upload Concern", description: "Uploaded drawing or photo raises concerns.", autoFlag: false },
  { id: "other", label: "Other", description: "Manual review required for other reasons.", autoFlag: false },
];
