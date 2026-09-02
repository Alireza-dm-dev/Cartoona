import { describe, test, expect } from "vitest";
import {
  ALL_ORDER_STATUSES,
  WORKFLOW_STATUSES,
  TERMINAL_STATUSES,
  FINAL_UPLOAD_ALLOWED_STATUSES,
  ORDER_STATUS_LABELS,
  mapOrderStatusLabel,
  isKnownOrderStatus,
  isWorkflowStatus,
  checkTransition,
  getAllowedNextStatuses,
  isTerminalStatus,
  canUploadFinalMedia,
  requiresApprovedFinalMedia,
  requiresRejectionReason,
  normalizeNote,
  NOTE_MAX_LENGTH,
  REQUEST_STATUS_DEFINITIONS,
  mapStatusTone,
  STATUS_TONES,
} from "@/lib/admin/requests/workflow";

describe("status model", () => {
  test("exactly the 8 existing statuses — no new values", () => {
    expect(ALL_ORDER_STATUSES).toEqual([
      "draft",
      "pending_payment",
      "pending_review",
      "in_progress",
      "ready",
      "delivered",
      "rejected",
      "cancelled",
    ]);
  });

  test("workflow statuses are a subset of all statuses", () => {
    for (const s of WORKFLOW_STATUSES) {
      expect(ALL_ORDER_STATUSES).toContain(s);
    }
  });

  test("terminal statuses never reopen", () => {
    expect(TERMINAL_STATUSES).toEqual(["delivered", "rejected", "cancelled"]);
    for (const s of TERMINAL_STATUSES) {
      expect(getAllowedNextStatuses(s)).toEqual([]);
      expect(requiresApprovedFinalMedia(s)).toBe(false);
    }
  });

  test("every definition has a Persian label", () => {
    for (const s of ALL_ORDER_STATUSES) {
      expect(typeof ORDER_STATUS_LABELS[s]).toBe("string");
      expect(ORDER_STATUS_LABELS[s].length).toBeGreaterThan(0);
      expect(REQUEST_STATUS_DEFINITIONS[s].label).toBe(ORDER_STATUS_LABELS[s]);
    }
  });

  test("unknown status falls back safely", () => {
    expect(isKnownOrderStatus("hologram")).toBe(false);
    expect(isKnownOrderStatus(null)).toBe(false);
    expect(isWorkflowStatus("hologram")).toBe(false);
    expect(mapOrderStatusLabel("hologram")).toBe("وضعیت نامشخص");
    expect(mapOrderStatusLabel(null)).toBe("وضعیت نامشخص");
    expect(mapStatusTone("hologram")).toBe("neutral");
  });

  test("all 8 statuses have a tone", () => {
    for (const s of ALL_ORDER_STATUSES) {
      expect(STATUS_TONES[s]).toBeDefined();
    }
  });
});

describe("transition map", () => {
  test("allowed next statuses per status", () => {
    expect(getAllowedNextStatuses("pending_review")).toEqual(["in_progress", "rejected", "cancelled"]);
    expect(getAllowedNextStatuses("in_progress")).toEqual(["ready", "rejected", "cancelled"]);
    expect(getAllowedNextStatuses("ready")).toEqual(["delivered"]);
    expect(getAllowedNextStatuses("delivered")).toEqual([]);
    expect(getAllowedNextStatuses("rejected")).toEqual([]);
    expect(getAllowedNextStatuses("cancelled")).toEqual([]);
    expect(getAllowedNextStatuses("draft")).toEqual([]);
    expect(getAllowedNextStatuses("pending_payment")).toEqual([]);
  });

  test("valid transitions pass", () => {
    expect(checkTransition("pending_review", "in_progress").ok).toBe(true);
    expect(checkTransition("pending_review", "rejected").ok).toBe(true);
    expect(checkTransition("pending_review", "cancelled").ok).toBe(true);
    expect(checkTransition("in_progress", "ready").ok).toBe(true);
    expect(checkTransition("in_progress", "rejected").ok).toBe(true);
    expect(checkTransition("ready", "delivered").ok).toBe(true);
  });

  test("invalid transitions are rejected", () => {
    expect(checkTransition("pending_review", "ready")).toEqual({ ok: false, code: "request_transition_invalid" });
    expect(checkTransition("pending_review", "delivered")).toEqual({ ok: false, code: "request_transition_invalid" });
    expect(checkTransition("in_progress", "delivered")).toEqual({ ok: false, code: "request_transition_invalid" });
    expect(checkTransition("ready", "in_progress")).toEqual({ ok: false, code: "request_transition_invalid" });
    expect(checkTransition("ready", "rejected")).toEqual({ ok: false, code: "request_transition_invalid" });
    expect(checkTransition("rejected", "pending_review")).toEqual({ ok: false, code: "request_transition_invalid" });
    expect(checkTransition("cancelled", "in_progress")).toEqual({ ok: false, code: "request_transition_invalid" });
    expect(checkTransition("delivered", "ready")).toEqual({ ok: false, code: "request_transition_invalid" });
  });

  test("no-op transitions are rejected", () => {
    expect(checkTransition("pending_review", "pending_review")).toEqual({
      ok: false,
      code: "request_status_unchanged",
    });
    expect(checkTransition("in_progress", "in_progress")).toEqual({
      ok: false,
      code: "request_status_unchanged",
    });
  });

  test("unknown target or missing source is invalid", () => {
    expect(checkTransition("pending_review", "bogus")).toEqual({ ok: false, code: "request_invalid_status" });
    expect(checkTransition(null, "ready")).toEqual({ ok: false, code: "request_invalid_status" });
    expect(checkTransition(undefined, "ready")).toEqual({ ok: false, code: "request_invalid_status" });
  });
});

describe("workflow rules", () => {
  test("upload allowed only for pending_review / in_progress / ready", () => {
    expect(FINAL_UPLOAD_ALLOWED_STATUSES).toEqual(["pending_review", "in_progress", "ready"]);
    expect(canUploadFinalMedia("pending_review")).toBe(true);
    expect(canUploadFinalMedia("in_progress")).toBe(true);
    expect(canUploadFinalMedia("ready")).toBe(true);
    expect(canUploadFinalMedia("delivered")).toBe(false);
    expect(canUploadFinalMedia("rejected")).toBe(false);
    expect(canUploadFinalMedia("cancelled")).toBe(false);
    expect(canUploadFinalMedia(null)).toBe(false);
  });

  test("ready requires approved final media; rejected requires reason", () => {
    // The DB enforces the final-media gate only at `ready` (delivered inherits
    // the invariant by being reachable only from ready).
    expect(requiresApprovedFinalMedia("ready")).toBe(true);
    expect(requiresApprovedFinalMedia("delivered")).toBe(false);
    expect(REQUEST_STATUS_DEFINITIONS.delivered.requiresApprovedFinalMedia).toBe(true);
    expect(requiresApprovedFinalMedia("in_progress")).toBe(false);
    expect(requiresRejectionReason("rejected")).toBe(true);
    expect(requiresRejectionReason("in_progress")).toBe(false);
    expect(requiresRejectionReason("cancelled")).toBe(false);
  });

  test("terminal detection", () => {
    expect(isTerminalStatus("delivered")).toBe(true);
    expect(isTerminalStatus("rejected")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("in_progress")).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
  });

  test("status definitions mirror the transition map", () => {
    for (const s of ALL_ORDER_STATUSES) {
      const def = REQUEST_STATUS_DEFINITIONS[s];
      expect(def.allowedNext).toEqual(getAllowedNextStatuses(s));
      for (const next of def.allowedNext) {
        expect(REQUEST_STATUS_DEFINITIONS[next].allowedPrevious).toContain(s);
      }
    }
  });

  test("workflow meaning mentions parent-visible deliverable for ready", () => {
    expect(REQUEST_STATUS_DEFINITIONS.ready.requiresApprovedFinalMedia).toBe(true);
    expect(REQUEST_STATUS_DEFINITIONS.ready.parentCanSee).toBe(true);
  });
});

describe("note normalization", () => {
  test("null/undefined become null", () => {
    expect(normalizeNote(null)).toEqual({ ok: true, value: null });
    expect(normalizeNote(undefined)).toEqual({ ok: true, value: null });
  });

  test("empty and whitespace-only become null", () => {
    expect(normalizeNote("")).toEqual({ ok: true, value: null });
    expect(normalizeNote("   ")).toEqual({ ok: true, value: null });
    expect(normalizeNote("\n\t ")).toEqual({ ok: true, value: null });
  });

  test("values are trimmed", () => {
    expect(normalizeNote("  یادداشت  ")).toEqual({ ok: true, value: "یادداشت" });
  });

  test("length limit is enforced", () => {
    const atLimit = "a".repeat(NOTE_MAX_LENGTH);
    expect(normalizeNote(atLimit)).toEqual({ ok: true, value: atLimit });
    expect(normalizeNote("a".repeat(NOTE_MAX_LENGTH + 1))).toEqual({
      ok: false,
      code: "request_note_too_long",
    });
  });

  test("non-string input is invalid", () => {
    expect(normalizeNote(12345)).toEqual({ ok: false, code: "request_note_invalid" });
    expect(normalizeNote({})).toEqual({ ok: false, code: "request_note_invalid" });
  });
});
