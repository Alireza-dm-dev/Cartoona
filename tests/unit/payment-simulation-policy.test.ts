import { describe, it, expect } from "vitest"

function isSimulationEnabled(env: Record<string, string | undefined>): boolean {
  if (env["NODE_ENV"] === "production") return false
  return env["CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION"] === "true"
}

describe("payment simulation policy", () => {
  it("production always rejects even with flag true", () => {
    expect(isSimulationEnabled({ NODE_ENV: "production", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "true" })).toBe(false)
  })

  it("production always rejects with flag false", () => {
    expect(isSimulationEnabled({ NODE_ENV: "production", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "false" })).toBe(false)
  })

  it("production always rejects with flag absent", () => {
    expect(isSimulationEnabled({ NODE_ENV: "production" })).toBe(false)
  })

  it("production always rejects with flag empty", () => {
    expect(isSimulationEnabled({ NODE_ENV: "production", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "" })).toBe(false)
  })

  it("development with flag true allows", () => {
    expect(isSimulationEnabled({ NODE_ENV: "development", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "true" })).toBe(true)
  })

  it("development with flag absent rejects", () => {
    expect(isSimulationEnabled({ NODE_ENV: "development" })).toBe(false)
  })

  it("development with flag false rejects", () => {
    expect(isSimulationEnabled({ NODE_ENV: "development", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "false" })).toBe(false)
  })

  it("test environment with flag absent rejects", () => {
    expect(isSimulationEnabled({ NODE_ENV: "test" })).toBe(false)
  })

  it("test environment with flag true allows", () => {
    expect(isSimulationEnabled({ NODE_ENV: "test", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "true" })).toBe(true)
  })

  it("test environment with flag false rejects", () => {
    expect(isSimulationEnabled({ NODE_ENV: "test", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "false" })).toBe(false)
  })

  it("unknown NODE_ENV with flag absent rejects (fail closed)", () => {
    expect(isSimulationEnabled({ NODE_ENV: "staging" })).toBe(false)
  })

  it("unknown NODE_ENV with flag true allows", () => {
    expect(isSimulationEnabled({ NODE_ENV: "staging", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "true" })).toBe(true)
  })

  it("missing NODE_ENV with flag absent rejects (fail closed)", () => {
    expect(isSimulationEnabled({})).toBe(false)
  })

  it("flag non-true values reject (whitespace)", () => {
    expect(isSimulationEnabled({ NODE_ENV: "development", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: " true " })).toBe(false)
  })

  it("flag non-true values reject (1)", () => {
    expect(isSimulationEnabled({ NODE_ENV: "development", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "1" })).toBe(false)
  })

  it("flag non-true values reject (yes)", () => {
    expect(isSimulationEnabled({ NODE_ENV: "development", CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION: "yes" })).toBe(false)
  })
})
