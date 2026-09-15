import { describe, it, expect } from "vitest"
import {
  getSafeParentDestination,
  resolveSuccessfulLoginDestination,
} from "@/lib/auth/parent-destinations"

describe("safe parent redirect targets", () => {
  it("accepts parent paths", () => {
    expect(getSafeParentDestination("/dashboard")).toBe("/dashboard")
    expect(getSafeParentDestination("/dashboard/orders")).toBe("/dashboard/orders")
    expect(getSafeParentDestination("/dashboard/orders/abc-123")).toBe("/dashboard/orders/abc-123")
    expect(getSafeParentDestination("/parent-consent")).toBe("/parent-consent")
    expect(getSafeParentDestination("/complete-request")).toBe("/complete-request")
  })

  it("strips query and hash before matching", () => {
    expect(getSafeParentDestination("/dashboard?tab=open")).toBe("/dashboard")
    expect(getSafeParentDestination("/dashboard#section")).toBe("/dashboard")
  })

  it("rejects off-site and malformed targets", () => {
    const rejected = [
      null,
      "",
      "https://evil.example/dashboard",
      "//evil.example",
      "http://localhost:3000/dashboard",
      "javascript:alert(1)",
      "data:text/html,x",
      "/dashboard/../../admin",
      "/dashboard\\..\\admin",
      "dashboard",
      "/admin",
      "/admin/orders",
      "/",
      "/login",
      "/dashboard%00",
      "/dashboard" + "x".repeat(300),
    ]
    for (const value of rejected) {
      expect(getSafeParentDestination(value), String(value)).toBeNull()
    }
  })

  it("rejects the admin area so a parent login cannot land there", () => {
    expect(getSafeParentDestination("/admin")).toBeNull()
    expect(getSafeParentDestination("/admin/requests")).toBeNull()
  })
})

describe("post-login destination", () => {
  it("defaults by consent state when there is no from=", () => {
    expect(resolveSuccessfulLoginDestination(null, true)).toBe("/dashboard")
    expect(resolveSuccessfulLoginDestination(null, false)).toBe("/parent-consent")
  })

  it("honours a safe from= for a consented parent", () => {
    expect(resolveSuccessfulLoginDestination("/dashboard/orders", true)).toBe("/dashboard/orders")
    expect(resolveSuccessfulLoginDestination("/complete-request", true)).toBe("/complete-request")
  })

  it("diverts an un-consented parent to consent first", () => {
    expect(resolveSuccessfulLoginDestination("/dashboard", false)).toBe("/parent-consent")
    expect(resolveSuccessfulLoginDestination("/dashboard/orders", false)).toBe("/parent-consent")
  })

  it("always allows the consent page itself", () => {
    expect(resolveSuccessfulLoginDestination("/parent-consent", false)).toBe("/parent-consent")
    expect(resolveSuccessfulLoginDestination("/parent-consent", true)).toBe("/parent-consent")
  })
})
