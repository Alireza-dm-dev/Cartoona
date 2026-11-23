import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"

const root = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")

// The build tool turns the static import into { src, width, height } with a
// content-hashed /_next/static/media URL. Mock that shape here.
vi.mock("@/assets/non-homepage/app-background.webp", () => ({
  default: { src: "/_next/static/media/app-background.abc123.webp", width: 2528, height: 1696 },
}))

const OLD_NAME = "hf_20260927_192006_6eb8e260-ff89-410e-b638-960d6a5cc702.png"

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx|css|mdx?)$/.test(entry.name)) out.push(rel)
  }
  return out
}

async function markup() {
  const { AppBackground } = await import("@/components/ui/app-background")
  return renderToStaticMarkup(createElement(AppBackground))
}

describe("AppBackground rendering", () => {
  it("renders one decorative image layer: aria-hidden, empty alt, not focusable", async () => {
    const html = await markup()
    // React 19 may hoist a <link rel=preload as=image> ahead of the layer; judge
    // the layer itself.
    const layer = html.slice(html.indexOf('<div class="app-bg-layer"'))
    expect(layer).toContain('aria-hidden="true"')
    expect(layer).toContain('alt=""')
    expect(layer).not.toMatch(/tabindex|role=|onclick|href=/i)
    expect(html.match(/<img/g)).toHaveLength(1)
    // One file for every viewport: no <picture>/<source> switching.
    expect(html).not.toMatch(/<picture|<source|srcset/i)
  })

  it("adds no preload/priority of its own (any preload is React's automatic image hoist for the same file)", async () => {
    const src = read("components/ui/app-background.tsx")
    expect(src).not.toMatch(/priority|fetchPriority|rel=["']preload/)
    const html = await markup()
    const links = html.match(/<link[^>]*>/g) ?? []
    for (const l of links) expect(l).toContain("app-background.abc123.webp")
  })

  it("uses the fingerprinted static-import URL with intrinsic dimensions, not a /public path", async () => {
    const html = await markup()
    expect(html).toContain('src="/_next/static/media/app-background.abc123.webp"')
    expect(html).toContain('width="2528"')
    expect(html).toContain('height="1696"')
    expect(html).not.toContain("/images/")
  })

  it("never references the homepage artwork", async () => {
    const html = await markup()
    expect(html).not.toMatch(/sections-bg|homepage/)
  })
})

describe("crop and layer behaviour is preserved (CSS)", () => {
  const css = read("app/globals.css")
  const base = css.slice(css.indexOf(".app-bg-layer {"), css.indexOf(".app-bg-layer::after"))

  it("is a fixed, non-interactive layer behind content", () => {
    expect(base).toMatch(/position:\s*fixed/)
    expect(base).toMatch(/inset:\s*0/)
    expect(base).toMatch(/z-index:\s*-1/)
    expect(base).toMatch(/pointer-events:\s*none/)
  })

  it("desktop: cover, centered", () => {
    expect(base).toMatch(/\.app-bg-layer img\s*\{[^}]*object-fit:\s*cover;[^}]*object-position:\s*center;/)
    expect(base).toMatch(/\.app-bg-layer img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%/)
  })

  it("<=640px: object-position center 65%", () => {
    const block = css.slice(css.indexOf("@media (max-width: 640px)"))
    expect(block).toMatch(/\.app-bg-layer img\s*\{\s*object-position:\s*center 65%;\s*\}/)
  })

  it("keeps the cream readability wash", () => {
    expect(css).toMatch(/\.app-bg-layer::after\s*\{[^}]*rgba\(255, 247, 232, 0\.62\)/)
  })
})

describe("asset hygiene", () => {
  it("the optimized WebP exists, is a real WebP at the original dimensions, and is small", async () => {
    const file = path.join(root, "assets/non-homepage/app-background.webp")
    const buf = fs.readFileSync(file)
    expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF")
    expect(buf.subarray(8, 12).toString("ascii")).toBe("WEBP")
    expect(buf.length).toBeLessThan(250 * 1024) // was 3,200,746 bytes
    const sharp = (await import("sharp")).default
    const meta = await sharp(file).metadata()
    expect([meta.width, meta.height]).toEqual([2528, 1696])
  })

  it("the old 3.2 MB PNG is gone from public/ and referenced nowhere in source", () => {
    expect(fs.existsSync(path.join(root, "public/images/non-homepage", OLD_NAME))).toBe(false)
    for (const dir of ["app", "components", "lib"]) {
      for (const file of walk(dir)) {
        const src = read(file)
        expect(src, file).not.toContain(OLD_NAME)
        expect(src, file).not.toContain("/images/non-homepage")
      }
    }
  })

  it("no oversized raster remains in the non-homepage surface (public/images/non-homepage is empty or small)", () => {
    const dir = path.join(root, "public/images/non-homepage")
    if (!fs.existsSync(dir)) return
    for (const f of fs.readdirSync(dir)) {
      expect(fs.statSync(path.join(dir, f)).size, f).toBeLessThan(500 * 1024)
    }
  })
})

describe("homepage is untouched", () => {
  it("homepage artwork files are kept and CMS slots point at their optimized, content-addressed copies", () => {
    // Originals stay in the repository until the optimized copies are verified in production.
    for (const f of ["sections-bg.png", "card-image.jpg", "family-tablet.jpg"]) {
      expect(fs.existsSync(path.join(root, "public/images/homepage", f)), f).toBe(true)
    }
    expect(fs.statSync(path.join(root, "public/images/homepage/sections-bg.png")).size).toBe(3455477)
    const slots = read("lib/homepage/media-slots.ts")
    for (const p of [
      "/media/homepage/sections-bg.eca947d36f.webp",
      "/media/homepage/card-image.51648e3ce9.webp",
      "/media/homepage/family-tablet.9122fad07c.webp",
    ]) {
      expect(slots).toContain(`"${p}"`)
      expect(fs.existsSync(path.join(root, "public", p)), p).toBe(true)
    }
  })

  it("the homepage does not render AppBackground", () => {
    expect(read("app/(marketing)/layout.tsx")).not.toContain("AppBackground")
    expect(read("app/(marketing)/page.tsx")).not.toContain("AppBackground")
  })

  it("every non-homepage surface still renders AppBackground", () => {
    for (const f of [
      "app/(dashboard)/layout.tsx",
      "app/(auth)/layout.tsx",
      "app/(creation)/layout.tsx",
      "app/admin/layout.tsx",
      "app/(marketing)/faq/page.tsx",
      "app/(marketing)/pricing/page.tsx",
      "app/(marketing)/safety/page.tsx",
      "app/(marketing)/characters/page.tsx",
      "app/(marketing)/examples/page.tsx",
    ]) {
      expect(read(f), f).toContain("<AppBackground")
    }
  })
})
