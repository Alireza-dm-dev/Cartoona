import { describe, it, expect } from "vitest";
import {
  deriveInitials,
  getParentAccountSummary,
} from "@/lib/auth/parent-account";
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
 */

const PARENT_USER = "11111111-1111-4111-8111-111111111111";

/** Minimal recording fake of the server Supabase client. */
function makeSupabase(options: {
  user?: { id: string } | null;
  role?: string | null;
  roleError?: boolean;
  fullName?: string | null;
  profileError?: boolean;
  authThrows?: boolean;
}) {
  const queried: string[] = [];
  return {
    queried,
    client: {
      auth: {
        getUser: async () => {
          if (options.authThrows) throw new Error("network down");
          return {
            data: { user: options.user === undefined ? { id: PARENT_USER } : options.user },
            error: null,
          };
        },
      },
      from: (table: string) => {
        queried.push(table);
        const api: Record<string, unknown> = {};
        api.select = () => api;
        api.eq = () => api;
        api.maybeSingle = () => {
          if (table === "users") {
            if (options.roleError) return { data: null, error: new Error("boom") };
            return {
              data: options.role === null ? null : { role: options.role ?? "parent" },
              error: null,
            };
          }
          if (options.profileError) return { data: null, error: new Error("boom") };
          return {
            data: options.fullName === null ? null : { full_name: options.fullName ?? "مریم رضایی" },
            error: null,
          };
        };
        return api;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

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

describe("public header account resolution", () => {
  it("returns a summary for an authenticated parent", async () => {
    const { client } = makeSupabase({ role: "parent", fullName: "مریم رضایی" });
    const account = await getParentAccountSummary(client);
    expect(account).toEqual({ displayName: "مریم رضایی", initials: "مر" });
  });

  it("returns null for an anonymous visitor, without querying", async () => {
    const { client, queried } = makeSupabase({ user: null });
    expect(await getParentAccountSummary(client)).toBeNull();
    expect(queried).toEqual([]);
  });

  it("returns null for an admin, so admins never get the parent drawer", async () => {
    for (const role of ["admin", "super_admin"]) {
      const { client } = makeSupabase({ role });
      expect(await getParentAccountSummary(client), role).toBeNull();
    }
  });

  it("requires the role to be exactly parent", async () => {
    for (const role of ["Parent", "PARENT", "", "guest", null]) {
      const { client } = makeSupabase({ role });
      expect(await getParentAccountSummary(client), String(role)).toBeNull();
    }
  });

  it("never reaches the profile table for a non-parent", async () => {
    const { client, queried } = makeSupabase({ role: "admin" });
    await getParentAccountSummary(client);
    expect(queried).toEqual(["users"]);
  });

  it("greets a parent whose profile row is missing rather than hiding the control", async () => {
    const { client } = makeSupabase({ role: "parent", fullName: null });
    expect(await getParentAccountSummary(client)).toEqual({
      displayName: "حساب والد",
      initials: "حو",
    });
  });

  it("degrades to anonymous when a lookup fails", async () => {
    expect(await getParentAccountSummary(makeSupabase({ roleError: true }).client)).toBeNull();
    expect(await getParentAccountSummary(makeSupabase({ profileError: true }).client)).toBeNull();
    expect(await getParentAccountSummary(makeSupabase({ authThrows: true }).client)).toBeNull();
  });

  it("exposes nothing beyond a name and initials", async () => {
    const { client } = makeSupabase({ role: "parent", fullName: "مریم رضایی" });
    const account = await getParentAccountSummary(client);
    expect(Object.keys(account!).sort()).toEqual(["displayName", "initials"]);
    // No id, no email, no phone, no role, no profile id.
    expect(JSON.stringify(account)).not.toContain(PARENT_USER);
    expect(JSON.stringify(account)).not.toContain("parent\"");
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
