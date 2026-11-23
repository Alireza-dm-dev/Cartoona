import { describe, expect, it } from "vitest"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  HOMEPAGE_DEFAULT_VIDEO_POSTERS,
  HOMEPAGE_MEDIA_SLOT_SPECS,
  defaultPosterFor,
} from "@/lib/homepage/media-slots"

/**
 * Performance pass: shipped homepage media is content-addressed under
 * public/media and served `immutable`. These tests are what make the long cache
 * lifetime safe: a file can never change behind an unchanged URL.
 */
const root = path.resolve(__dirname, "../..")
const mediaDir = path.join(root, "public/media")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  )
}

describe("content-addressed public media", () => {
  const files = walk(mediaDir)

  it("has files", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files.map((f) => [path.relative(root, f), f]))("%s: the name carries the first 10 hex of its SHA-256", (_rel, file) => {
    const m = path.basename(file).match(/^[a-z0-9-]+\.([0-9a-f]{10})\.(webp|avif|mp4|jpg|png)$/)
    expect(m, "name must be <name>.<10-hex sha256>.<ext>").not.toBeNull()
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 10)
    expect(m![1]).toBe(digest)
  })

  it("every default slot path and every default poster exists", () => {
    const paths = [
      ...Object.values(HOMEPAGE_MEDIA_SLOT_SPECS).map((s) => s.currentPublicPath),
      ...Object.keys(HOMEPAGE_DEFAULT_VIDEO_POSTERS),
      ...Object.values(HOMEPAGE_DEFAULT_VIDEO_POSTERS),
    ]
    for (const p of paths) expect(fs.existsSync(path.join(root, "public", p)), p).toBe(true)
  })

  it("posters belong to the shipped default videos only", () => {
    for (const spec of Object.values(HOMEPAGE_MEDIA_SLOT_SPECS)) {
      if (spec.mediaType === "video") expect(defaultPosterFor(spec.currentPublicPath), spec.slot).toBeDefined()
    }
    expect(defaultPosterFor("https://cdn.example.test/storage/uploaded.mp4")).toBeUndefined()
  })
})

describe("caching and loading rules", () => {
  const config = read("next.config.ts")

  it("marks exactly /media/:path* immutable, and nothing else", () => {
    expect(config).toMatch(/source:\s*"\/media\/:path\*"/)
    expect(config).toContain("public, max-age=31536000, immutable")
    expect(config.match(/source:/g)).toHaveLength(1)
  })

  it("homepage videos are deferred (no eager autoplay <video>)", () => {
    for (const f of ["components/marketing/Hero.tsx", "components/marketing/CreationTypeCard.tsx"]) {
      const src = read(f)
      expect(src, f).not.toMatch(/<video[\s\S]{0,200}autoPlay/)
      expect(src, f).toContain("<LazyVideo")
    }
    const lazy = read("components/marketing/LazyVideo.tsx")
    expect(lazy).toContain('preload="none"')
    expect(lazy).toContain("src={active ? src : undefined}")
  })

  it("the hero artwork is preloaded at high priority; below-the-fold images are lazy", () => {
    const hero = read("components/marketing/Hero.tsx")
    expect(hero).toMatch(/preload\(media\.background,\s*\{\s*as:\s*"image",\s*fetchPriority:\s*"high"/)
    expect(read("components/marketing/CreationTypeCard.tsx")).toContain('loading="lazy"')
    expect(read("components/marketing/SafetySection.tsx")).toContain('loading="lazy"')
  })
})
