import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveInitials, toParentAccountSummary } from "@/lib/auth/parent-account";
import { getPublicHeaderAccount } from "@/lib/auth/public-header-account";
import type { IdentityVerification } from "@/lib/auth/supabase-identity-adapter";
import { verifyAssertion } from "@/lib/identity/assertion";
import { toVerifiedIdentity } from "@/lib/identity/types";
import { PARENT_NAV_ITEMS } from "@/lib/parent/navigation/parent-nav";
import { CREATION_CHOICES, CREATION_ROUTES } from "@/lib/creation/creation-routes";

/**
 * The public site's account control: who it appears for, what it is allowed to
 * know about them, and which destinations the drawer offers.
 *
 * The drawer's markup is covered by the guarded browser spec. What is asserted
 * here is the part that must never regress silently — the role gate, the
 * shape of the summary, and the fact that the drawer's destinations come from
 * the shared config rather than a second copy of the list.
 *
 * V0.1.46: the name comes from the backend (GET /v1/parent/profile), and the
 * role gate is the backend's requireRole("parent"). Here the identity adapter
 * is mocked and `fetch` stands in for Fastify; the real chain is
 * parent-account-cutover-db.test.ts.
 */

const PARENT_USER = "11111111-1111-4111-8111-111111111111";
const SECRET_HEX = "77".repeat(32);
const BASE = "http://backend.internal.test:4000";

const m = vi.hoisted(() => ({ verification: null as unknown, verifyCalls: 0 }));
vi.mock("@/lib/auth/supabase-identity-adapter", () => ({
  verifySupabaseIdentity: async () => {
    m.verifyCalls += 1;
    return m.verification;
  },
}));

const signedIn = (): IdentityVerification => ({
  ok: true,
  context: { identity: toVerifiedIdentity({ provider: "supabase", subject: PARENT_USER }), authenticatedAt: Date.now() - 3_600_000 },
});

let calls: { url: string; headers: Record<string, string> }[];
let answer: () => Promise<Response>;
const backend = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubEnv("BACKEND_INTERNAL_URL", BASE);
  vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "300");
  vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", SECRET_HEX);
  m.verification = signedIn();
  m.verifyCalls = 0;
  calls = [];
  answer = backend(200, { fullName: "مریم رضایی" });
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return answer();
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const lookup = () => getPublicHeaderAccount({});

describe("avatar initials", () => {
  it("uses the first letter of the first two words", () => {
    expect(deriveInitials("مریم رضایی")).toBe("مر");
    expect(deriveInitials("Sara Ahmadi")).toBe("SA");
  });

  it("handles a single-word name", () => {
    expect(deriveInitials("مریم")).toBe("م");
  });

  it("ignores extra words and whitespace", () => {
    expect(deriveInitials("  علی  رضا  محمدی  ")).toBe("عر");
  });

  it("never renders punctuation as an initial", () => {
    expect(deriveInitials("- -")).toBe("؟");
    expect(deriveInitials("«»")).toBe("؟");
    expect(deriveInitials("   ")).toBe("؟");
  });
});

describe("public header account resolution (V0.1.46: backend)", () => {
  it("returns a summary for an authenticated parent, from ONE signed GET /v1/parent/profile", async () => {
    expect(await lookup()).toEqual({ displayName: "مریم رضایی", initials: "مر" });
    expect(m.verifyCalls).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/parent/profile`]);
    const verified = verifyAssertion({ token: calls[0].headers["x-cartoona-internal-auth"], secret: Buffer.from(SECRET_HEX, "hex"), method: "GET", path: "/v1/parent/profile" });
    expect(verified.ok && verified.claims.subject).toBe(PARENT_USER);
    expect(Object.keys(calls[0].headers).sort()).toEqual(["accept", "x-cartoona-internal-auth", "x-request-id"]);
  });

  it("returns null for an anonymous visitor, without calling the backend", async () => {
    for (const reason of ["no_session", "invalid_session", "session_expired", "auth_unavailable"] as const) {
      m.verification = { ok: false, reason };
      expect(await lookup(), reason).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("returns null for an admin, super_admin or deleted account (backend 403), so they never get the parent drawer", async () => {
    answer = backend(403, { error: "forbidden" });
    expect(await lookup()).toBeNull();
    answer = backend(403, { error: "identity_not_linked" });
    expect(await lookup()).toBeNull();
  });

  it("returns null when the backend ends the session (invalidated / expired), and never signs out", async () => {
    for (const error of ["session_invalidated", "session_expired", "unauthenticated"]) {
      answer = backend(401, { error });
      expect(await lookup(), error).toBeNull();
    }
  });

  it("greets a parent whose profile row is missing, or has no name, rather than hiding the control", async () => {
    answer = backend(404, { error: "parent_profile_not_found" });
    expect(await lookup()).toEqual({ displayName: "حساب والد", initials: "حو" });
    answer = backend(200, { fullName: null });
    expect(await lookup()).toEqual({ displayName: "حساب والد", initials: "حو" });
    expect(toParentAccountSummary("   ")).toEqual({ displayName: "حساب والد", initials: "حو" });
  });

  it("degrades to anonymous when the backend fails, is slow or answers out of contract", async () => {
    for (const [label, a] of [
      ["db 503", backend(503, { error: "service_unavailable" })],
      ["malformed", backend(200, { fullName: 42 })],
      ["unknown error", backend(403, { error: "admin" })],
      ["refused", async () => { throw new TypeError("fetch failed"); }],
    ] as const) {
      answer = a as () => Promise<Response>;
      expect(await lookup(), label).toBeNull();
    }
  });

  it("is bounded by the header deadline even if the backend hangs", async () => {
    answer = () => new Promise<Response>(() => {});
    const t = Date.now();
    expect(await getPublicHeaderAccount({ deadlineMs: 200 })).toBeNull();
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it("exposes nothing beyond a name and initials, even if the backend sends more", async () => {
    answer = backend(200, { fullName: "مریم رضایی", id: "b1000000-0000-4000-8000-000000000001", userId: PARENT_USER, role: "parent" });
    const account = await lookup();
    expect(Object.keys(account!).sort()).toEqual(["displayName", "initials"]);
    expect(JSON.stringify(account)).not.toContain(PARENT_USER);
    expect(JSON.stringify(account)).not.toMatch(/b1000000|parent"/);
  });
});

describe("account drawer destinations", () => {
  it("offers the canonical parent portal destinations", () => {
    expect(PARENT_NAV_ITEMS.map((i) => i.href)).toEqual([
      "/dashboard/orders",
      "/dashboard/gallery",
      "/dashboard/settings#profile",
      "/dashboard/billing",
      "/dashboard/referrals",
      "/dashboard/settings",
    ]);
  });

  it("has no dashboard entry", () => {
    expect(PARENT_NAV_ITEMS.some((i) => i.label === "داشبورد")).toBe(false);
    expect(PARENT_NAV_ITEMS.some((i) => i.href === "/dashboard")).toBe(false);
  });

  it("labels the discount entry گرفتن تخفیف", () => {
    const referral = PARENT_NAV_ITEMS.find((i) => i.href === "/dashboard/referrals");
    expect(referral?.label).toBe("گرفتن تخفیف");
  });

  it("keeps creation on the public routes", () => {
    expect(CREATION_CHOICES.map((c) => c.href)).toEqual([
      CREATION_ROUTES.image,
      CREATION_ROUTES.video,
      CREATION_ROUTES.drawing_animation,
    ]);
    for (const choice of CREATION_CHOICES) {
      expect(choice.href.startsWith("/dashboard")).toBe(false);
    }
  });
});
