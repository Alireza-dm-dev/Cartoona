import { describe, it, expect } from "vitest"
import { isValidSubmissionKey } from "@/lib/requests/submission-key"

/**
 * The shape check the API route runs on `submissionKey` before it ever
 * reaches the trusted RPC. Only a UUID is accepted — never free text — so
 * this is the boundary that keeps that rule real.
 */

describe("isValidSubmissionKey", () => {
  it("accepts a well-formed UUID, any case", () => {
    expect(isValidSubmissionKey("11111111-1111-4111-8111-111111111111")).toBe(true)
    expect(isValidSubmissionKey("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(true)
  })

  it("rejects free text and near-misses", () => {
    for (const bad of [
      "",
      "not-a-uuid",
      "11111111-1111-1111-1111-111111111111 ",
      " 11111111-1111-1111-1111-111111111111",
      "11111111111141118111111111111111",
      "'; drop table orders;--",
      "../../etc/passwd",
      "<script>",
    ]) {
      expect(isValidSubmissionKey(bad), bad).toBe(false)
    }
  })

  it("rejects non-string values", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(isValidSubmissionKey(bad)).toBe(false)
    }
  })
})
