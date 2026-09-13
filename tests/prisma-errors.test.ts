import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

describe("isUniqueConstraintError", () => {
  it("recognizes Prisma's unique-constraint violation code", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
  });

  it("rejects everything else without throwing", () => {
    expect(isUniqueConstraintError({ code: "P2025" })).toBe(false);
    expect(isUniqueConstraintError(new Error("boom"))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
    expect(isUniqueConstraintError("P2002")).toBe(false);
    expect(isUniqueConstraintError(42)).toBe(false);
  });
});
