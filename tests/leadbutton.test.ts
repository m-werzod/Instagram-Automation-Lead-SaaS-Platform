import { describe, expect, it } from "vitest";
import { buttonSpecSchema, parseButtonSpec, DEFAULT_BUTTON_SPEC, leadButtonSaveSchema } from "@/lib/validation/leadbutton";
import { leadButtonStyle } from "@/lib/leadbutton-style";
import { DICTIONARIES } from "@/lib/i18n/dictionaries";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/i18n/config";

describe("ButtonSpec validation", () => {
  it("accepts a full valid spec", () => {
    const res = buttonSpecSchema.safeParse({
      label: "Ro‘yxatdan o‘tish",
      helper: "Bepul",
      bg: "#4f46e5",
      fg: "#ffffff",
      border: null,
      shape: "pill",
      size: "lg",
      style: "filled",
      position: "bottom",
    });
    expect(res.success).toBe(true);
  });

  it("rejects non-hex colours (prevents CSS injection through the spec)", () => {
    for (const bad of ["red", "#fff", "url(x)", "#12345g", "javascript:alert(1)"]) {
      expect(buttonSpecSchema.safeParse({ ...DEFAULT_BUTTON_SPEC, bg: bad }).success, bad).toBe(false);
    }
  });

  it("rejects an empty or over-long label", () => {
    expect(buttonSpecSchema.safeParse({ ...DEFAULT_BUTTON_SPEC, label: "" }).success).toBe(false);
    expect(buttonSpecSchema.safeParse({ ...DEFAULT_BUTTON_SPEC, label: "x".repeat(31) }).success).toBe(false);
  });

  it("parseButtonSpec falls back to the default for legacy/garbage rows", () => {
    expect(parseButtonSpec(null)).toEqual(DEFAULT_BUTTON_SPEC);
    expect(parseButtonSpec({ nonsense: true })).toEqual(DEFAULT_BUTTON_SPEC);
    expect(parseButtonSpec(undefined)).toEqual(DEFAULT_BUTTON_SPEC);
  });

  it("full save payload requires at least one question and a headline", () => {
    const base = {
      accountId: "a1",
      enabled: true,
      headline: "So‘rov qoldiring",
      buttonSpec: DEFAULT_BUTTON_SPEC,
      contentId: null,
      ctaType: "SIGN_UP",
      triggerKeywords: ["start"],
      questions: [
        { title: "Ism", prompt: "Ismingiz nima?", type: "TEXT", required: true, options: [] },
      ],
    };
    expect(leadButtonSaveSchema.safeParse(base).success).toBe(true);
    expect(leadButtonSaveSchema.safeParse({ ...base, questions: [] }).success).toBe(false);
    expect(leadButtonSaveSchema.safeParse({ ...base, headline: "" }).success).toBe(false);
  });
});

describe("leadButtonStyle (preview == landing page)", () => {
  it("maps shape to border radius", () => {
    expect(leadButtonStyle({ ...DEFAULT_BUTTON_SPEC, shape: "pill" }).borderRadius).toBe("9999px");
    expect(leadButtonStyle({ ...DEFAULT_BUTTON_SPEC, shape: "square" }).borderRadius).toBe("4px");
  });

  it("outline style uses transparent background and coloured text", () => {
    const s = leadButtonStyle({ ...DEFAULT_BUTTON_SPEC, style: "outline", bg: "#111111", border: null });
    expect(s.background).toBe("transparent");
    expect(s.color).toBe("#111111");
  });

  it("filled style uses bg/fg as given", () => {
    const s = leadButtonStyle({ ...DEFAULT_BUTTON_SPEC, bg: "#16a34a", fg: "#ffffff" });
    expect(s.background).toBe("#16a34a");
    expect(s.color).toBe("#ffffff");
  });
});

describe("localization completeness", () => {
  it("Uzbek is the default locale", () => {
    expect(DEFAULT_LOCALE).toBe("uz");
  });

  it("every locale ships a dictionary with an identical key tree", () => {
    type Tree = Record<string, unknown>;
    const shape = (obj: Tree, prefix = ""): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? shape(v as Tree, `${prefix}${k}.`)
          : [`${prefix}${k}:${typeof v}`],
      );
    const reference = shape(DICTIONARIES.en as unknown as Tree).sort();
    for (const locale of LOCALES) {
      expect(shape(DICTIONARIES[locale] as unknown as Tree).sort(), locale).toEqual(reference);
    }
  });

  it("no dictionary leaks empty strings", () => {
    const walk = (obj: Record<string, unknown>, path: string): void => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") expect(v.trim().length, `${path}.${k}`).toBeGreaterThan(0);
        else if (v !== null && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, `${path}.${k}`);
      }
    };
    for (const locale of LOCALES) walk(DICTIONARIES[locale] as unknown as Record<string, unknown>, locale);
  });
});
