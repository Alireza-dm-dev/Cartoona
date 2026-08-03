import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target";

const BASE = "http://localhost:3000";
const PROJECT_REF = "oucyhmrnzahlhqjfqcge";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;

function loadEnv(): void {
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      process.env[key] = val;
    }
  } catch { /* fallback */ }
}
loadEnv();

const _guard = assertSafeDatabaseTarget();
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`);

const ADMIN_KEY = process.env.SUPABASE_SECRET_KEY || "";

function adminHeaders() {
  return { "Content-Type": "application/json", apikey: ADMIN_KEY, Authorization: `Bearer ${ADMIN_KEY}` };
}

const TS = String(Date.now()).slice(-8);
const EMAIL_OWNER = `ref_owner_${TS}@test.com`;
const EMAIL_TARGET = `ref_target_${TS}@test.com`;
const EMAIL_THIRD = `ref_third_${TS}@test.com`;

interface SessionData {
  uid: string;
  cookieValue: string;
  accessToken: string;
}

let ownerSession: SessionData | null = null;
let targetSession: SessionData | null = null;
let thirdSession: SessionData | null = null;
let ownerCode = "";

async function createSession(email: string): Promise<SessionData> {
  // Create auth user
  const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password: "TestPass999!", email_confirm: true, user_metadata: { full_name: "Test" } }),
  });
  if (!createResp.ok) throw new Error(`Create user ${email}: ${await createResp.text()}`);
  const user = await createResp.json();
  const uid = user.id;

  // Create parent profile with consent
  await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ user_id: uid, full_name: `Test ${email}`, consent_granted: true, consent_granted_at: new Date().toISOString() }),
  }).catch(() => {});

  // Sign in via password grant
  const loginResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password: "TestPass999!" }),
  });
  const loginData = await loginResp.json();

  const sessionObj = {
    access_token: loginData.access_token,
    refresh_token: loginData.refresh_token,
    expires_in: loginData.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + loginData.expires_in,
    token_type: "bearer",
  };
  const cookieValue = "base64-" + Buffer.from(JSON.stringify(sessionObj)).toString("base64url");

  return { uid, cookieValue, accessToken: loginData.access_token };
}

async function fetchOwnerCode(): Promise<string> {
  if (!ownerSession) return "";
  const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_current_parent_referral_summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ADMIN_KEY, Authorization: `Bearer ${ownerSession.accessToken}` },
  });
  if (!rpcResp.ok) return "";
  const data = await rpcResp.json();
  return Array.isArray(data) && data.length > 0 ? data[0].referral_code || "" : "";
}

async function cleanup(emails: string[]) {
  const listResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, { headers: adminHeaders() });
  const list = await listResp.json();
  for (const u of list.users || []) {
    if (emails.includes(u.email)) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: adminHeaders() }).catch(() => {});
    }
  }
}

test.beforeAll(async () => {
  ownerSession = await createSession(EMAIL_OWNER);
  targetSession = await createSession(EMAIL_TARGET);
  thirdSession = await createSession(EMAIL_THIRD);
  ownerCode = await fetchOwnerCode();
});

test.afterAll(async () => {
  await cleanup([EMAIL_OWNER, EMAIL_TARGET, EMAIL_THIRD]);
});

const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

function cookieHeader(session: SessionData | null): Record<string, string> {
  if (!session) return {};
  return { Cookie: `${COOKIE_NAME}=${session.cookieValue}` };
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/referrals
// ═════════════════════════════════════════════════════════════════════════════

test.describe("GET /api/referrals", () => {
  test("unauthenticated → 401", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/referrals`);
    expect(resp.status()).toBe(401);
  });

  test("active parent → 200 with correct shape", async ({ request }) => {
    test.skip(!ownerSession, "No session");
    const resp = await request.get(`${BASE}/api/referrals`, { headers: cookieHeader(ownerSession) });
    expect(resp.status()).toBe(200);

    const body = await resp.json();
    expect(body).toHaveProperty("referralCode");
    expect(typeof body.referralCode).toBe("string");
    expect(body.referralCode).toMatch(/^CT[0-9A-F]{12}$/);

    expect(body).toHaveProperty("program");
    expect(body.program).toHaveProperty("isEnabled", true);
    expect(body.program).toHaveProperty("rewardBasisPoints", 1500);

    expect(body).toHaveProperty("binding");
    expect(typeof body.binding.isBound).toBe("boolean");

    expect(body).toHaveProperty("referredCount");
    expect(typeof body.referredCount).toBe("number");
  });

  test("no private identity fields", async ({ request }) => {
    test.skip(!ownerSession, "No session");
    const resp = await request.get(`${BASE}/api/referrals`, { headers: cookieHeader(ownerSession) });
    const body = await resp.json();

    const forbidden = ["referrerId", "referrerCode", "referrerName", "referredParents", "emails", "phones"];
    for (const key of forbidden) {
      expect(body).not.toHaveProperty(key);
    }
  });

  test("no-store and nosniff headers", async ({ request }) => {
    test.skip(!ownerSession, "No session");
    const resp = await request.get(`${BASE}/api/referrals`, { headers: cookieHeader(ownerSession) });
    const headers = resp.headers();
    expect(headers["cache-control"]).toMatch(/no-store/);
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/referrals/bind — validation
// ═════════════════════════════════════════════════════════════════════════════

test.describe("POST /api/referrals/bind — validation", () => {
  test("wrong Content-Type → 415", async ({ request }) => {
    test.skip(!targetSession, "No session");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(targetSession), "Content-Type": "text/plain" },
      data: "test",
    });
    expect(resp.status()).toBe(415);
  });

  test("invalid JSON → 400", async ({ request }) => {
    test.skip(!targetSession, "No session");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(targetSession), "Content-Type": "application/json" },
      data: "not-json",
    });
    expect(resp.status()).toBe(400);
  });

  test("missing code field → 400", async ({ request }) => {
    test.skip(!targetSession, "No session");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(targetSession), "Content-Type": "application/json" },
      data: "{}",
    });
    expect(resp.status()).toBe(400);
  });

  test("extra body field → 400", async ({ request }) => {
    test.skip(!targetSession, "No session");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(targetSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: "CT12AB34CD56EF", extra: true }),
    });
    expect(resp.status()).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/referrals/bind — business logic
// ═════════════════════════════════════════════════════════════════════════════

test.describe("POST /api/referrals/bind — business logic", () => {
  test("valid other-parent code → 200 bound", async ({ request }) => {
    test.skip(!targetSession || !ownerCode, "Missing data");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(targetSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: ownerCode }),
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("bound");
    expect(body.message).toBeTruthy();
  });

  test("same code again → 200 already_bound", async ({ request }) => {
    test.skip(!targetSession || !ownerCode, "Missing data");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(targetSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: ownerCode }),
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("already_bound");
  });

  test("different code after binding → 409", async ({ request }) => {
    test.skip(!targetSession, "Missing data");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(targetSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: "CTFFFFFFFFFFFF" }),
    });
    expect(resp.status()).toBe(409);
    const body = await resp.json();
    expect(body.code).toBe("REFERRAL_ALREADY_BOUND");
  });

  test("self code → 422 REFERRAL_CODE_INVALID", async ({ request }) => {
    test.skip(!ownerSession || !ownerCode, "Missing data");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(ownerSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: ownerCode }),
    });
    expect(resp.status()).toBe(422);
    const body = await resp.json();
    expect(body.code).toBe("REFERRAL_CODE_INVALID");
  });

  test("unknown code → 422 REFERRAL_CODE_INVALID", async ({ request }) => {
    test.skip(!thirdSession, "Missing data");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(thirdSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: "CTAAAAAAAAAAAA" }),
    });
    expect(resp.status()).toBe(422);
    const body = await resp.json();
    expect(body.code).toBe("REFERRAL_CODE_INVALID");
  });

  test("malformed code → 422 REFERRAL_CODE_INVALID", async ({ request }) => {
    test.skip(!thirdSession, "Missing data");
    const resp = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(thirdSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: "invalid" }),
    });
    expect(resp.status()).toBe(422);
    const body = await resp.json();
    expect(body.code).toBe("REFERRAL_CODE_INVALID");
  });

  test("self/unknown/malformed share same error message", async ({ request }) => {
    test.skip(!ownerSession || !thirdSession || !ownerCode, "Missing data");

    const resp1 = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(ownerSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: ownerCode }),
    });
    const resp2 = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(thirdSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: "CTAAAAAAAAAAAA" }),
    });
    const resp3 = await request.post(`${BASE}/api/referrals/bind`, {
      headers: { ...cookieHeader(thirdSession), "Content-Type": "application/json" },
      data: JSON.stringify({ code: "invalid" }),
    });

    const [b1, b2, b3] = await Promise.all([resp1.json(), resp2.json(), resp3.json()]);
    expect(b1.error).toBe(b2.error);
    expect(b2.error).toBe(b3.error);
    expect(b1.code).toBe("REFERRAL_CODE_INVALID");
  });
});
