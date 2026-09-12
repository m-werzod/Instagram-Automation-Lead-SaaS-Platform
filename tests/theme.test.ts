import { describe, expect, it } from "vitest";
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  isThemePreference,
  normalizeTheme,
  THEME_COOKIE,
  THEME_INIT_SCRIPT,
  THEMES,
} from "@/lib/theme/config";

describe("theme preference", () => {
  it("offers exactly light, dark and auto", () => {
    expect([...THEMES]).toEqual(["light", "dark", "system"]);
  });

  it("follows the operating system until told otherwise", () => {
    expect(DEFAULT_THEME).toBe("system");
  });

  it("normalises anything unrecognised instead of rendering a broken theme", () => {
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("system")).toBe("system");
    // stale cookie, hand-edited value, or a value from a future version
    expect(normalizeTheme("midnight")).toBe(DEFAULT_THEME);
    expect(normalizeTheme(undefined)).toBe(DEFAULT_THEME);
    expect(normalizeTheme(null)).toBe(DEFAULT_THEME);
    expect(normalizeTheme(42)).toBe(DEFAULT_THEME);
    expect(isThemePreference("DARK")).toBe(false);
  });
});

/**
 * The no-flash script is a hand-written string that cannot be type-checked and
 * runs before anything else on the page. These assertions pin the three things
 * that silently break dark mode if they drift: the cookie name it reads, the
 * media query it falls back to, and the attribute the stylesheet keys off.
 */
describe("pre-paint theme script", () => {
  it("reads the same cookie the provider writes", () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_COOKIE);
  });

  it("falls back to the OS preference and writes data-theme", () => {
    expect(THEME_INIT_SCRIPT).toContain(DARK_MEDIA_QUERY);
    expect(THEME_INIT_SCRIPT).toContain("data-theme");
  });

  it("is self-contained and cannot break the page", () => {
    // wrapped in an IIFE so it leaks no globals, and in try/catch so a blocked
    // cookie jar or matchMedia-less browser degrades to the light default
    expect(THEME_INIT_SCRIPT.startsWith("(function(){")).toBe(true);
    expect(THEME_INIT_SCRIPT).toContain("try{");
    expect(THEME_INIT_SCRIPT).toContain("catch");
    expect(THEME_INIT_SCRIPT).not.toContain("</script");
  });

  it("actually resolves each preference when executed", () => {
    const run = (cookie: string, osDark: boolean) => {
      const attrs: Record<string, string> = {};
      const sandbox = {
        document: { cookie, documentElement: { setAttribute: (k: string, v: string) => void (attrs[k] = v) } },
        window: { matchMedia: () => ({ matches: osDark }) },
      };
      new Function("document", "window", THEME_INIT_SCRIPT)(sandbox.document, sandbox.window);
      return attrs["data-theme"];
    };

    expect(run(`${THEME_COOKIE}=dark`, false)).toBe("dark");
    expect(run(`${THEME_COOKIE}=light`, true)).toBe("light");
    // "system" and a missing cookie both defer to the OS
    expect(run(`${THEME_COOKIE}=system`, true)).toBe("dark");
    expect(run(`${THEME_COOKIE}=system`, false)).toBe("light");
    expect(run("", true)).toBe("dark");
    expect(run("", false)).toBe("light");
    // the cookie is found even when it is not the first one
    expect(run(`app_locale=ru; ${THEME_COOKIE}=dark`, false)).toBe("dark");
  });
});
