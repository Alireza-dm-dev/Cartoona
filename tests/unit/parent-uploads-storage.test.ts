import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
const calls: Array<[string, ...unknown[]]> = []
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (...a: unknown[]) => (calls.push(["upload", bucket, ...a]), { error: null }),
        copy: async (...a: unknown[]) => (calls.push(["copy", bucket, ...a]), { error: null }),
        remove: async (...a: unknown[]) => (calls.push(["remove", bucket, ...a]), { error: null }),
      }),
    },
  }),
}))

import { copyParentSource, isOwnedUploadKey, removeParentSource, uploadParentSource } from "@/lib/storage/parent-uploads"

const U = "11111111-1111-4111-8111-111111111111"
const O = "22222222-2222-4222-8222-222222222222"

describe("parent upload namespace (V0.1.54)", () => {
  it.each([
    [`${U}/${O}/a.png`, U, true],
    [`other/${O}/a.png`, U, false],
    [`${U}/${O}/../x`, U, false],
    [`${U}/${O}`, U, false],
    [`${U}/${O}/a/b`, U, false],
    [`/${U}/${O}/a`, U, false],
    [`${U}//a`, U, false],
    [`${U}/${O}/a.png`, "", false],
    [`${U}/${O}/a.png`, `${U}/x`, false],
  ])("isOwnedUploadKey(%s, %s) -> %s", (key, subject, ok) => {
    expect(isOwnedUploadKey(key, subject)).toBe(ok)
  })

  it("writes only inside the subject's folder, in the private bucket, never upserting", async () => {
    calls.length = 0
    expect(await uploadParentSource(U, `${U}/${O}/a.png`, new Blob(["x"]), "image/png")).toBeNull()
    expect(calls[0].slice(0, 2)).toEqual(["upload", "parent-uploads"])
    expect(calls[0][4]).toEqual({ contentType: "image/png", upsert: false })
  })

  it("refuses a foreign key without touching Storage", async () => {
    calls.length = 0
    expect(await uploadParentSource(U, `someone-else/${O}/a.png`, new Blob(["x"]), "image/png")).not.toBeNull()
    expect(await copyParentSource(U, `someone-else/${O}/a.png`, `${U}/${O}/b.png`)).not.toBeNull()
    expect(await copyParentSource(U, `${U}/${O}/a.png`, `someone-else/${O}/b.png`)).not.toBeNull()
    expect(await removeParentSource(U, `someone-else/${O}/a.png`)).not.toBeNull()
    expect(calls).toEqual([])
  })
})
