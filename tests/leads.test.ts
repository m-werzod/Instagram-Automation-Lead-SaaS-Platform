import { describe, expect, it } from "vitest";
import { isQualificationLevel } from "@/lib/leads";

describe("isQualificationLevel", () => {
  it("accepts exactly the three AI qualification scores", () => {
    expect(isQualificationLevel("LOW")).toBe(true);
    expect(isQualificationLevel("MEDIUM")).toBe(true);
    expect(isQualificationLevel("HIGH")).toBe(true);
  });
  it("rejects anything else, including lowercase and unrelated values", () => {
    expect(isQualificationLevel("low")).toBe(false);
    expect(isQualificationLevel("URGENT")).toBe(false);
    expect(isQualificationLevel(null)).toBe(false);
    expect(isQualificationLevel(undefined)).toBe(false);
    expect(isQualificationLevel(1)).toBe(false);
  });
});
