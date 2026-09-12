import { describe, expect, it } from "vitest";
import { resolveAccountFilter, whereFromFilter, isStaff } from "@/lib/auth/access";

/**
 * Account-level authorization is decided by one pure function so the rules
 * can be pinned down without a database: OWNER/ADMIN are unrestricted, a
 * USER is confined to the accounts granted to them, and asking for an
 * account you do not hold is a 403 — never an empty list that hides the fact.
 */
describe("resolveAccountFilter", () => {
  it("lets staff see everything when no account is requested", () => {
    expect(resolveAccountFilter("OWNER", [], null)).toEqual({ kind: "all" });
    expect(resolveAccountFilter("ADMIN", [], undefined)).toEqual({ kind: "all" });
  });

  it("lets staff narrow to any single account", () => {
    expect(resolveAccountFilter("ADMIN", [], "acc_1")).toEqual({ kind: "one", id: "acc_1" });
  });

  it("confines a USER to the granted set", () => {
    expect(resolveAccountFilter("USER", ["a", "b"], null)).toEqual({ kind: "many", ids: ["a", "b"] });
    // no grants → sees nothing, but the query is still valid
    expect(resolveAccountFilter("USER", [], null)).toEqual({ kind: "many", ids: [] });
  });

  it("allows a USER to select an account they hold and refuses one they do not", () => {
    expect(resolveAccountFilter("USER", ["a", "b"], "b")).toEqual({ kind: "one", id: "b" });
    expect(resolveAccountFilter("USER", ["a", "b"], "c")).toEqual({ kind: "forbidden", id: "c" });
  });
});

describe("whereFromFilter", () => {
  it("produces the matching Prisma fragments", () => {
    expect(whereFromFilter({ kind: "all" })).toEqual({});
    expect(whereFromFilter({ kind: "one", id: "x" })).toEqual({ accountId: "x" });
    expect(whereFromFilter({ kind: "many", ids: ["x", "y"] })).toEqual({ accountId: { in: ["x", "y"] } });
  });

  it("turns a forbidden request into a 403 AppError rather than an empty result", () => {
    expect(() => whereFromFilter({ kind: "forbidden", id: "x" })).toThrowError(/access/i);
    try {
      whereFromFilter({ kind: "forbidden", id: "x" });
    } catch (err) {
      expect((err as { status: number }).status).toBe(403);
      expect((err as { code: string }).code).toBe("FORBIDDEN");
    }
  });
});

describe("isStaff", () => {
  it("treats OWNER and ADMIN as staff, USER as not", () => {
    const ctx = (role: "OWNER" | "ADMIN" | "USER") => ({ admin: { id: "1", login: "x", email: null, name: "x", role } });
    expect(isStaff(ctx("OWNER"))).toBe(true);
    expect(isStaff(ctx("ADMIN"))).toBe(true);
    expect(isStaff(ctx("USER"))).toBe(false);
  });
});
