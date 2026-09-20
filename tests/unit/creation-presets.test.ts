import { describe, it, expect } from "vitest";
import {
  IMAGE_OCCASION_PRESETS,
  IMAGE_SCENE_PRESETS,
  IMAGE_STYLE_PRESETS,
  VIDEO_OCCASION_PRESETS,
  VIDEO_STORY_PRESETS,
  matchPreset,
  type CreationPreset,
} from "@/lib/creation/creation-presets";
import { parseAndValidateDraft } from "@/lib/requests/request-submission";

/**
 * Creation form presets.
 *
 * Presets are a writing aid over ordinary text fields, so what matters is that
 * the values they write are real text the existing submission path accepts,
 * and that selection stays derived from the field rather than tracked beside
 * it. The chip interactions themselves are covered by the browser spec.
 */

const ALL_GROUPS: [string, readonly CreationPreset[]][] = [
  ["image scene", IMAGE_SCENE_PRESETS],
  ["image style", IMAGE_STYLE_PRESETS],
  ["image occasion", IMAGE_OCCASION_PRESETS],
  ["video story", VIDEO_STORY_PRESETS],
  ["video occasion", VIDEO_OCCASION_PRESETS],
];

describe("preset catalogue", () => {
  it("offers the expected choices for each field", () => {
    expect(IMAGE_SCENE_PRESETS).toHaveLength(10);
    expect(IMAGE_STYLE_PRESETS).toHaveLength(10);
    expect(IMAGE_OCCASION_PRESETS).toHaveLength(11);
    expect(VIDEO_STORY_PRESETS).toHaveLength(10);
    expect(VIDEO_OCCASION_PRESETS).toHaveLength(10);
  });

  it("names the video story choices requested", () => {
    expect(VIDEO_STORY_PRESETS.map((p) => p.label)).toEqual([
      "جشن تولد کودک",
      "ماجراجویی در جنگل",
      "سفر به فضا",
      "بازی با دوستان",
      "نجات یک حیوان",
      "مسابقه و رقابت دوستانه",
      "جشن در مدرسه",
      "دیدار با شخصیت محبوب",
      "ماجراجویی در دنیای جادویی",
      "داستان خانوادگی شاد",
    ]);
  });

  it("names the image scene choices requested", () => {
    expect(IMAGE_SCENE_PRESETS.map((p) => p.label)).toEqual([
      "کودک در کنار شخصیت محبوبش",
      "جشن تولد",
      "ماجراجویی در جنگل",
      "دنیای جادویی",
      "سفر به فضا",
      "کنار حیوانات",
      "قهرمان داستان",
      "بازی در پارک",
      "کنار خانواده",
      "جشن و بادکنک",
    ]);
  });

  it("uses the label itself for the short style and occasion fields", () => {
    for (const group of [IMAGE_STYLE_PRESETS, IMAGE_OCCASION_PRESETS, VIDEO_OCCASION_PRESETS]) {
      for (const preset of group) expect(preset.value).toBe(preset.label);
    }
  });

  it("writes a full starter sentence for scene and story, not just the label", () => {
    for (const group of [IMAGE_SCENE_PRESETS, VIDEO_STORY_PRESETS]) {
      for (const preset of group) {
        expect(preset.value).not.toBe(preset.label);
        expect(preset.value.length).toBeGreaterThan(preset.label.length);
        expect(preset.value.endsWith(".")).toBe(true);
      }
    }
  });

  it("keeps labels and values unique within every group", () => {
    for (const [name, group] of ALL_GROUPS) {
      expect(new Set(group.map((p) => p.label)).size, name).toBe(group.length);
      expect(new Set(group.map((p) => p.value)).size, name).toBe(group.length);
    }
  });

  it("never writes an empty or untrimmed value", () => {
    for (const [name, group] of ALL_GROUPS) {
      for (const preset of group) {
        expect(preset.value.trim(), name).toBe(preset.value);
        expect(preset.value.length, name).toBeGreaterThan(0);
        expect(preset.label.trim(), name).toBe(preset.label);
      }
    }
  });

  it("refers to the chosen character generically, never a licensed name", () => {
    for (const group of [IMAGE_SCENE_PRESETS, VIDEO_STORY_PRESETS]) {
      for (const preset of group) {
        // Starter copy that mentions a character says "شخصیت انتخاب‌شده".
        const mentions = preset.value.includes("شخصیت");
        if (mentions) expect(preset.value).toContain("شخصیت انتخاب‌شده");
      }
    }
  });
});

describe("derived selection", () => {
  it("marks the preset whose value the field currently holds", () => {
    const preset = VIDEO_STORY_PRESETS[2];
    expect(matchPreset(VIDEO_STORY_PRESETS, preset.value)).toBe(preset);
  });

  it("selects nothing for an empty field", () => {
    expect(matchPreset(VIDEO_STORY_PRESETS, "")).toBeNull();
  });

  it("selects nothing once the parent edits the generated text", () => {
    const edited = VIDEO_STORY_PRESETS[0].value + " و کیک شکلاتی داشته باشد.";
    expect(matchPreset(VIDEO_STORY_PRESETS, edited)).toBeNull();
  });

  it("selects nothing for text the parent wrote themselves", () => {
    expect(matchPreset(IMAGE_STYLE_PRESETS, "سبک دلخواه من")).toBeNull();
    expect(matchPreset(IMAGE_SCENE_PRESETS, "یک صحنه کاملاً دلخواه")).toBeNull();
  });

  it("moves the selection when a different preset is chosen", () => {
    // Choosing replaces the field's text outright, so exactly one chip can
    // ever match.
    const first = IMAGE_SCENE_PRESETS[0];
    const second = IMAGE_SCENE_PRESETS[4];
    expect(matchPreset(IMAGE_SCENE_PRESETS, first.value)).toBe(first);
    expect(matchPreset(IMAGE_SCENE_PRESETS, second.value)).toBe(second);
    expect(
      IMAGE_SCENE_PRESETS.filter((p) => p.value === second.value),
    ).toHaveLength(1);
  });

  it("does not match across groups that share a label", () => {
    // "تولد" is offered for both image occasion and video occasion; matching
    // is always scoped to the group the chip belongs to.
    expect(matchPreset(IMAGE_STYLE_PRESETS, "تولد")).toBeNull();
  });
});

describe("preset values flow through the existing submission path", () => {
  const imageDraft = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      createdAt: "2026-09-17T00:00:00.000Z",
      estimatedCandyCost: 12,
      type: "image",
      selectedCharacterId: "داینو دودو",
      sceneDescription: IMAGE_SCENE_PRESETS[0].value,
      style: IMAGE_STYLE_PRESETS[0].value,
      occasion: IMAGE_OCCASION_PRESETS[0].value,
      parentNote: "",
      referenceFileName: "",
      ...over,
    });

  const videoDraft = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      createdAt: "2026-09-17T00:00:00.000Z",
      estimatedCandyCost: 40,
      type: "video",
      selectedCharacterId: "داینو دودو",
      storyDescription: VIDEO_STORY_PRESETS[0].value,
      duration: "5_10",
      charactersSpeak: true,
      occasion: VIDEO_OCCASION_PRESETS[0].value,
      parentNote: "",
      referenceFileName: "",
      ...over,
    });

  it("accepts preset-generated image text and carries it verbatim", () => {
    const result = parseAndValidateDraft(imageDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.description).toContain(IMAGE_SCENE_PRESETS[0].value);
    expect(result.data.description).toContain(IMAGE_STYLE_PRESETS[0].value);
    expect(result.data.description).toContain(IMAGE_OCCASION_PRESETS[0].value);
  });

  it("accepts preset-generated video text and carries it verbatim", () => {
    const result = parseAndValidateDraft(videoDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.videoScript).toBe(VIDEO_STORY_PRESETS[0].value);
    expect(result.data.description).toContain(VIDEO_OCCASION_PRESETS[0].value);
  });

  it("accepts a custom value just the same", () => {
    const custom = "یک صحنه کاملاً دلخواه که والد نوشته است";
    const result = parseAndValidateDraft(imageDraft({ sceneDescription: custom, style: "سبک دلخواه" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.description).toContain(custom);
  });

  it("accepts an edited preset value", () => {
    const edited = VIDEO_STORY_PRESETS[0].value + " و در پایان همه با هم بخندند.";
    const result = parseAndValidateDraft(videoDraft({ storyDescription: edited }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.videoScript).toBe(edited);
  });

  it("still rejects a missing required story, presets or not", () => {
    const result = parseAndValidateDraft(videoDraft({ storyDescription: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.field === "storyDescription")).toBe(true);
  });

  it("keeps the occasion fields optional", () => {
    expect(parseAndValidateDraft(imageDraft({ occasion: "" })).ok).toBe(true);
    expect(parseAndValidateDraft(videoDraft({ occasion: "" })).ok).toBe(true);
  });

  it("persists no preset identity — only the text", () => {
    const result = parseAndValidateDraft(imageDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("preset");
    expect(serialized).not.toContain("presetId");
  });
});
