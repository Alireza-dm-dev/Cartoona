import { describe, it, expect } from "vitest";
import {
  CHILD_NAME_MAX_LENGTH,
  checkChildName,
  isValidChildName,
  normalizeChildName,
} from "@/lib/creation/child-name";
import { parseAndValidateDraft } from "@/lib/requests/request-submission";
import {
  CARTOONA_CREATION_DRAFT_KEY,
  readCreationDraft,
  saveCreationDraft,
} from "@/lib/creation/creation-draft";
import type { ImageCreationDraft, VideoCreationDraft } from "@/lib/creation/creation-draft";

/**
 * The optional child name on the image and video creation forms.
 *
 * The name is stored in its own `orders.child_name` column rather than being
 * folded into the description, so these tests care about it surviving as a
 * discrete value from the form through the draft to the submission parser.
 */

describe("child name normalization", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeChildName("  آریا  ")).toBe("آریا");
    expect(normalizeChildName("علی    رضا")).toBe("علی رضا");
  });

  it("treats blank input as no name rather than an empty name", () => {
    // The column rejects a blank string, so "" must never survive to the API.
    expect(normalizeChildName("")).toBeNull();
    expect(normalizeChildName("    ")).toBeNull();
    expect(normalizeChildName(null)).toBeNull();
    expect(normalizeChildName(undefined)).toBeNull();
  });
});

describe("child name validation", () => {
  it("accepts Persian, Latin and mixed real names", () => {
    for (const name of ["آریا", "Aria", "علی‌رضا", "Anne-Marie", "مریم احمدی", "Zoë"]) {
      expect(isValidChildName(name)).toBe(true);
    }
  });

  it("rejects values with no letter in them", () => {
    // Guards against "12345" and "..." without second-guessing which alphabet
    // a family's name is written in.
    for (const junk of ["12345", "...", "---", "۱۲۳"]) {
      expect(isValidChildName(junk)).toBe(false);
    }
  });

  it("rejects a name longer than the column allows", () => {
    expect(isValidChildName("آ".repeat(CHILD_NAME_MAX_LENGTH))).toBe(true);
    expect(isValidChildName("آ".repeat(CHILD_NAME_MAX_LENGTH + 1))).toBe(false);
  });

  it("reports an empty field as a valid, complete answer", () => {
    // Optional means optional: leaving it blank is not an error state.
    expect(checkChildName("")).toEqual({ ok: true, value: null });
    expect(checkChildName("   ")).toEqual({ ok: true, value: null });
  });

  it("returns the normalized value the form should store", () => {
    expect(checkChildName("  آریا ")).toEqual({ ok: true, value: "آریا" });
  });

  it("explains a filled-in but unusable value", () => {
    const result = checkChildName("12345");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("نام کودک");
  });
});

const imageDraft = (childName?: unknown): Record<string, unknown> => ({
  version: 1,
  createdAt: new Date().toISOString(),
  estimatedCandyCost: 10,
  type: "image",
  selectedCharacterId: "لوپو",
  sceneDescription: "صحنه‌ای شاد",
  style: "کارتونی نرم",
  occasion: "",
  parentNote: "",
  referenceFileName: "",
  ...(childName === undefined ? {} : { childName }),
});

const videoDraft = (childName?: unknown): Record<string, unknown> => ({
  version: 1,
  createdAt: new Date().toISOString(),
  estimatedCandyCost: 20,
  type: "video",
  selectedCharacterId: "لوپو",
  storyDescription: "یک داستان کوتاه",
  duration: "5_10",
  charactersSpeak: true,
  occasion: "",
  parentNote: "",
  referenceFileName: "",
  ...(childName === undefined ? {} : { childName }),
});

describe("child name through the submission parser", () => {
  it("preserves an image child name as its own field", () => {
    const result = parseAndValidateDraft(JSON.stringify(imageDraft("آریا")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.childName).toBe("آریا");
      // Structured, not buried: the description must not have absorbed it.
      expect(result.data.description).not.toContain("آریا");
    }
  });

  it("preserves a video child name as its own field", () => {
    const result = parseAndValidateDraft(JSON.stringify(videoDraft("آریا")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.childName).toBe("آریا");
      expect(result.data.description).not.toContain("آریا");
    }
  });

  it("normalizes on the way through", () => {
    const result = parseAndValidateDraft(JSON.stringify(imageDraft("  آریا  ")));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.childName).toBe("آریا");
  });

  it("accepts a version 1 draft that predates the field", () => {
    // The field was added without bumping the draft version, so a draft
    // already sitting in a parent's sessionStorage must still submit.
    for (const draft of [imageDraft(), videoDraft()]) {
      const result = parseAndValidateDraft(JSON.stringify(draft));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.childName).toBeNull();
    }
  });

  it("treats null and blank as no name", () => {
    for (const value of [null, "", "   "]) {
      const result = parseAndValidateDraft(JSON.stringify(imageDraft(value)));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.childName).toBeNull();
    }
  });

  it("rejects a draft carrying an unusable name", () => {
    const result = parseAndValidateDraft(JSON.stringify(imageDraft("12345")));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "childName")).toBe(true);
    }
  });

  it("rejects a name longer than the column allows", () => {
    const result = parseAndValidateDraft(
      JSON.stringify(videoDraft("آ".repeat(CHILD_NAME_MAX_LENGTH + 1))),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "childName")).toBe(true);
    }
  });

  it("leaves drawing requests without a child name", () => {
    // The drawing form does not collect one in this phase.
    const result = parseAndValidateDraft(
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        estimatedCandyCost: 30,
        type: "drawing",
        drawingFileName: "naghashi.png",
        title: "نقاشی من",
        movementType: "پرواز",
        animationDescription: "",
        backgroundScene: "",
        duration: "کوتاه",
        parentNote: "",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.childName).toBeNull();
  });
});

describe("child name survives the sessionStorage round trip", () => {
  /** Minimal sessionStorage stand-in; the draft module only needs these three. */
  function installStorage(): void {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    // The module reads `window` for its guard and `sessionStorage` for its work.
    (globalThis as unknown as { window: unknown }).window = globalThis;
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = storage;
  }

  it("reads back the same name it stored", () => {
    installStorage();
    const draft = { ...imageDraft("آریا") } as unknown as ImageCreationDraft;

    saveCreationDraft(draft);
    const loaded = readCreationDraft();

    expect(loaded?.type).toBe("image");
    expect((loaded as ImageCreationDraft).childName).toBe("آریا");
  });

  it("reads back a video name across the signup interruption", () => {
    installStorage();
    const draft = { ...videoDraft("آریا") } as unknown as VideoCreationDraft;

    saveCreationDraft(draft);
    // A fresh read is what the signup, consent and complete-request pages do.
    const loaded = readCreationDraft();

    expect((loaded as VideoCreationDraft).childName).toBe("آریا");
  });

  it("still loads a stored draft written before the field existed", () => {
    installStorage();
    const legacy = imageDraft();
    sessionStorage.setItem(CARTOONA_CREATION_DRAFT_KEY, JSON.stringify(legacy));

    const loaded = readCreationDraft();

    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(1);
    expect((loaded as ImageCreationDraft).childName).toBeUndefined();
  });
});
