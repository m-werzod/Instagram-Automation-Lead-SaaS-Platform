import { describe, expect, it } from "vitest";
import { classifyAuthError } from "@/lib/meta/oauth";

/**
 * Meta returns `access_denied` for two completely different situations: the
 * person tapped Cancel, and the app refused to let them approve at all. Telling
 * them apart is the difference between "try again" and "the app owner must add
 * you as a tester", so the wording Meta sends is the only signal available.
 */
describe("authorization error classification", () => {
  it("recognises Development Mode refusals as a configuration problem", () => {
    // the exact shape Instagram sends when the account holds no role on the app
    expect(classifyAuthError("access_denied", "Insufficient developer role")).toBe("dev_mode");
    expect(classifyAuthError("access_denied", "insufficient developer role.")).toBe("dev_mode");
    expect(classifyAuthError("access_denied", "This app is in development mode")).toBe("dev_mode");
    expect(classifyAuthError("access_denied", "The app is not active")).toBe("dev_mode");
  });

  it("still reports a genuine cancellation as a cancellation", () => {
    expect(classifyAuthError("user_denied", "The user denied your request")).toBe("denied");
    expect(classifyAuthError("access_denied", "")).toBe("denied");
  });

  it("separates a missing permission on the app from everything else", () => {
    expect(classifyAuthError("invalid_request", "Invalid Scopes: instagram_business_manage_insights")).toBe(
      "invalid_scopes",
    );
  });

  it("falls back to a generic Meta error rather than guessing", () => {
    expect(classifyAuthError("server_error", "Something went wrong")).toBe("meta_error");
    expect(classifyAuthError("weird_new_code", "")).toBe("meta_error");
  });

  it("matches on the error code too, not only the description", () => {
    // some responses carry the reason in error_reason with no description
    expect(classifyAuthError("insufficient_developer_role", "")).toBe("dev_mode");
  });
});
