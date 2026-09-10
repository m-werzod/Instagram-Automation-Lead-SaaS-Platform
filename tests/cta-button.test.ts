import { describe, expect, it } from "vitest";
import { SUPPORTED_CTA_TYPES, SUPPORTED_OBJECTIVES } from "@/lib/meta/marketing";

/**
 * The CTA button is the whole point of promoting a Reel, so the values we send
 * to Meta are pinned here. If someone widens the list, these tests force a
 * conscious decision rather than a silent guess.
 */

describe("supported ad CTA buttons", () => {
  it("offers the labels a lead-generation business actually needs", () => {
    const values = SUPPORTED_CTA_TYPES.map((c) => c.value);
    for (const expected of ["SIGN_UP", "LEARN_MORE", "CONTACT_US", "BOOK_NOW", "GET_QUOTE", "APPLY_NOW"]) {
      expect(values, `${expected} must be offerable`).toContain(expected);
    }
  });

  it("every exposed button is a real Meta call_to_action enum value", () => {
    // Verified against the Marketing API AdCreative reference (docs/META_API.md §8).
    const known = new Set([
      "LEARN_MORE",
      "SIGN_UP",
      "CONTACT_US",
      "GET_QUOTE",
      "SUBSCRIBE",
      "BOOK_NOW",
      "APPLY_NOW",
      "SHOP_NOW",
      "BUY_NOW",
      "DOWNLOAD",
      "MESSAGE_PAGE",
      "OPEN_LINK",
      "DONATE",
    ]);
    for (const cta of SUPPORTED_CTA_TYPES) {
      expect(known, `${cta.value} is not a documented enum value`).toContain(cta.value);
    }
  });

  it("every button has a human-readable label for the UI", () => {
    for (const cta of SUPPORTED_CTA_TYPES) {
      expect(cta.label.length).toBeGreaterThan(2);
      expect(cta.label).not.toBe(cta.value); // never show the raw enum to an admin
    }
  });
});

describe("supported campaign objectives", () => {
  it("uses current ODAX objective names only", () => {
    for (const o of SUPPORTED_OBJECTIVES) {
      expect(o.value, `${o.value} must be an ODAX name`).toMatch(/^OUTCOME_/);
    }
  });

  it("covers the routes a Reel button can send someone to", () => {
    const values = SUPPORTED_OBJECTIVES.map((o) => o.value);
    expect(values).toContain("OUTCOME_TRAFFIC"); // button opens a landing page
    expect(values).toContain("OUTCOME_LEADS"); // button opens a Meta Instant Form
    expect(values).toContain("OUTCOME_ENGAGEMENT"); // button opens an Instagram DM
  });
});
