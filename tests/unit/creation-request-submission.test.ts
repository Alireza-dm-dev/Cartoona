import { describe, test, expect } from "vitest"
import { parseAndValidateDraft } from "@/lib/requests/request-submission"
import { mapRequestTitle } from "@/lib/admin/requests/mappers"
import {
  VIDEO_DURATION_TO_INTERNAL,
  isVideoDurationChoice,
  mapVideoDurationLabel,
} from "@/lib/pricing/pricing-keys"

const imageDraft = {
  version: 1,
  createdAt: "2026-09-15T00:00:00.000Z",
  estimatedCandyCost: 12,
  type: "image",
  selectedCharacterId: "داینو دودو",
  sceneDescription: "یک جنگل پر از پروانه",
  style: "کارتونی نرم",
  occasion: "",
  parentNote: "",
  referenceFileName: "",
}

const videoDraft = {
  version: 1,
  createdAt: "2026-09-15T00:00:00.000Z",
  estimatedCandyCost: 40,
  type: "video",
  selectedCharacterId: "داینو دودو",
  storyDescription: "ماجرای شب مهتابی",
  duration: "5_10",
  charactersSpeak: true,
  occasion: "",
  parentNote: "",
  referenceFileName: "",
}

function parse(draft: unknown) {
  return parseAndValidateDraft(JSON.stringify(draft))
}

describe("create image without a title", () => {
  test("accepts a draft carrying no title at all", () => {
    const result = parse(imageDraft)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.title).toBeNull()
  })

  test("never substitutes a placeholder title", () => {
    const result = parse(imageDraft)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.stringify(result.data)).not.toContain("تصویر بدون عنوان")
  })

  test("still requires a character", () => {
    const result = parse({ ...imageDraft, selectedCharacterId: "" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].field).toBe("selectedCharacterId")
  })
})

describe("request video without title or style", () => {
  test("accepts a draft with neither title nor style", () => {
    const result = parse(videoDraft)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.title).toBeNull()
    expect(result.data.videoStyle).toBeNull()
  })

  test("ignores a style left over in an older draft rather than persisting it", () => {
    const result = parse({ ...videoDraft, style: "سه‌بعدی" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.videoStyle).toBeNull()
  })

  test("still requires the story description", () => {
    const result = parse({ ...videoDraft, storyDescription: "  " })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.field)).toContain("storyDescription")
  })
})

describe("video duration choices", () => {
  test.each([
    ["5_10", "short", "۵ تا ۱۰ ثانیه"],
    ["10_20", "medium", "۱۰ تا ۲۰ ثانیه"],
    ["30_plus", "long", "بیش از ۳۰ ثانیه"],
  ])("%s is accepted and maps to the %s pricing tier", (choice, tier, label) => {
    const result = parse({ ...videoDraft, duration: choice })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.durationChoice).toBe(choice)
    // Pricing tier is unchanged: the same three catalog keys as before.
    expect(result.data.durationKey).toBe(tier)
    expect(mapVideoDurationLabel(choice)).toBe(label)
  })

  test("there is no 20-30 second option", () => {
    expect(isVideoDurationChoice("20_30")).toBe(false)
    expect(Object.keys(VIDEO_DURATION_TO_INTERNAL)).toEqual(["5_10", "10_20", "30_plus"])
  })

  test.each(["20_30", "کوتاه", "", "5-10", null, 5])(
    "rejects the unknown duration %p",
    (duration) => {
      const result = parse({ ...videoDraft, duration })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors.map((e) => e.field)).toContain("duration")
    },
  )
})

describe("characters-speak selection", () => {
  test("true is carried through to persistence", () => {
    const result = parse({ ...videoDraft, charactersSpeak: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.charactersSpeak).toBe(true)
  })

  test("false is carried through to persistence, not dropped as falsy", () => {
    const result = parse({ ...videoDraft, charactersSpeak: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.charactersSpeak).toBe(false)
  })

  test("a missing selection is rejected for a new request", () => {
    const withoutSpeech: Record<string, unknown> = { ...videoDraft }
    delete withoutSpeech.charactersSpeak
    const result = parse(withoutSpeech)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.field)).toContain("charactersSpeak")
  })

  test.each(["true", "yes", 1, 0, null])("rejects the malformed value %p", (value) => {
    const result = parse({ ...videoDraft, charactersSpeak: value })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.field)).toContain("charactersSpeak")
  })

  test("image requests carry no speech flag", () => {
    const result = parse(imageDraft)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.charactersSpeak).toBeNull()
    expect(result.data.durationChoice).toBeNull()
  })
})

describe("drawing animation is untouched", () => {
  const drawingDraft = {
    version: 1,
    createdAt: "2026-09-15T00:00:00.000Z",
    estimatedCandyCost: 35,
    type: "drawing",
    drawingFileName: "naghashi.png",
    title: "اژدهای کوچک",
    movementType: "حرکت آرام و لطیف",
    animationDescription: "",
    backgroundScene: "",
    duration: "کوتاه",
    parentNote: "",
  }

  test("keeps its own title and Persian duration keys", () => {
    const result = parse(drawingDraft)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.title).toBe("اژدهای کوچک")
    expect(result.data.durationKey).toBe("short")
    expect(result.data.charactersSpeak).toBeNull()
  })

  test("still requires a title", () => {
    const withoutTitle: Record<string, unknown> = { ...drawingDraft }
    delete withoutTitle.title
    const result = parse(withoutTitle)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].field).toBe("title")
  })
})

describe("untitled requests stay readable", () => {
  test("a null title is labelled rather than blanked", () => {
    expect(mapRequestTitle(null)).toBe("درخواست بدون عنوان")
    expect(mapRequestTitle("   ")).toBe("درخواست بدون عنوان")
  })

  test("a historical title is preserved verbatim", () => {
    expect(mapRequestTitle("ماجرای شب مهتابی")).toBe("ماجرای شب مهتابی")
  })
})
