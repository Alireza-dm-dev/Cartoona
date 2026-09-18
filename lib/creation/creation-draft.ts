import type { FormDuration, VideoDurationChoice } from "@/lib/pricing/pricing-keys";

type CreationDraftBase = {
  version: 1;
  createdAt: string;
  estimatedCandyCost: number;
};

export type ImageCreationDraft = CreationDraftBase & {
  type: "image";
  selectedCharacterId: string;
  sceneDescription: string;
  style: string;
  occasion: string;
  parentNote: string;
  referenceFileName: string;
  /**
   * Optional child name, kept beside the reference file it belongs with.
   *
   * Optional in the type as well as in the form: drafts written before this
   * field existed are still version 1 and must keep loading, so every reader
   * has to treat it as possibly absent rather than possibly empty.
   */
  childName?: string | null;
};

export type VideoCreationDraft = CreationDraftBase & {
  type: "video";
  selectedCharacterId: string;
  storyDescription: string;
  duration: VideoDurationChoice;
  /** Required for every new video request; never inferred for old drafts. */
  charactersSpeak: boolean;
  occasion: string;
  parentNote: string;
  referenceFileName: string;
  /** Optional child name. See `ImageCreationDraft.childName`. */
  childName?: string | null;
};

export type DrawingCreationDraft = CreationDraftBase & {
  type: "drawing";
  drawingFileName: string;
  title: string;
  movementType: string;
  animationDescription: string;
  backgroundScene: string;
  duration: FormDuration;
  parentNote: string;
};

export type CreationDraft =
  | ImageCreationDraft
  | VideoCreationDraft
  | DrawingCreationDraft;

export const CARTOONA_CREATION_DRAFT_KEY = "cartoona_creation_draft_v1";

export function saveCreationDraft(draft: CreationDraft): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(CARTOONA_CREATION_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // storage unavailable
  }
}

export function readCreationDraft(): CreationDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CARTOONA_CREATION_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== 1) return null;
    if (!["image", "video", "drawing"].includes(parsed.type)) return null;
    return parsed as CreationDraft;
  } catch {
    return null;
  }
}

export function clearCreationDraft(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(CARTOONA_CREATION_DRAFT_KEY);
  } catch {
    // storage unavailable
  }
}
