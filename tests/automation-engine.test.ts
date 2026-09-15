import { describe, expect, it } from "vitest";
import {
  allConditionsMatch,
  conditionMatches,
  contentScopeMatches,
  isWithinCooldown,
  OUTBOUND_ACTIONS,
  type AutomationCondition,
  type TriggerContext,
} from "@/lib/automation/engine";

const ctx: TriggerContext = {
  accountId: "a1",
  text: "Salom, kurs NARXI qancha?",
  source: "instagram_dm",
  leadStatus: "NEW",
  username: "demo_buyer",
};

describe("automation condition matching", () => {
  it("contains is case-insensitive", () => {
    expect(conditionMatches({ field: "text", op: "contains", value: "narxi" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "contains", value: "refund" }, ctx)).toBe(false);
  });

  it("not_contains", () => {
    expect(conditionMatches({ field: "text", op: "not_contains", value: "refund" }, ctx)).toBe(true);
  });

  it("equals matches whole value", () => {
    expect(conditionMatches({ field: "source", op: "equals", value: "instagram_dm" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "source", op: "equals", value: "instagram" }, ctx)).toBe(false);
  });

  it("starts_with", () => {
    expect(conditionMatches({ field: "username", op: "starts_with", value: "demo" }, ctx)).toBe(true);
  });

  it("regex works and invalid regex fails closed", () => {
    expect(conditionMatches({ field: "text", op: "regex", value: "narx\\w+" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "regex", value: "([" }, ctx)).toBe(false);
  });

  it("missing field value compares as empty string", () => {
    expect(conditionMatches({ field: "lead_status", op: "equals", value: "" }, { accountId: "x" })).toBe(true);
  });

  it("allConditionsMatch ANDs conditions and treats empty/invalid lists as pass", () => {
    const conditions: AutomationCondition[] = [
      { field: "text", op: "contains", value: "narx" },
      { field: "source", op: "equals", value: "instagram_dm" },
    ];
    expect(allConditionsMatch(conditions, ctx)).toBe(true);
    expect(allConditionsMatch([...conditions, { field: "text", op: "contains", value: "xyz" }], ctx)).toBe(false);
    expect(allConditionsMatch([], ctx)).toBe(true);
    expect(allConditionsMatch(null, ctx)).toBe(true);
    expect(allConditionsMatch("garbage", ctx)).toBe(true);
  });

  it("outbound action set covers exactly the message-sending actions", () => {
    expect([...OUTBOUND_ACTIONS].sort()).toEqual(
      ["REPLY_COMMENT", "SEND_MESSAGE", "SEND_PRIVATE_REPLY", "SEND_COMMENT_RESOURCE", "START_LEAD_FLOW"].sort(),
    );
  });
});

/**
 * A rule scoped to one post/reel must only fire for comments on THAT post —
 * an unscoped rule (contentId null) still applies to every post, so a typo
 * here would either silence every comment-resource rule or spam every post.
 */
describe("contentScopeMatches", () => {
  it("an unscoped rule (null/undefined contentId) matches every comment", () => {
    expect(contentScopeMatches(null, { accountId: "a1", contentId: "post_1" })).toBe(true);
    expect(contentScopeMatches(undefined, { accountId: "a1", contentId: "post_1" })).toBe(true);
    expect(contentScopeMatches(null, { accountId: "a1" })).toBe(true);
  });

  it("a scoped rule only matches its own post", () => {
    expect(contentScopeMatches("post_1", { accountId: "a1", contentId: "post_1" })).toBe(true);
    expect(contentScopeMatches("post_1", { accountId: "a1", contentId: "post_2" })).toBe(false);
  });

  it("a scoped rule never matches a comment whose post couldn't be resolved locally", () => {
    expect(contentScopeMatches("post_1", { accountId: "a1" })).toBe(false);
  });
});

/**
 * Per-user repeat protection (spec: "duplicate message protection") — a rule
 * with no cooldown configured, or no prior run for this person, must always
 * be allowed to fire; only an actual recent SUCCESS within the window blocks
 * it. Getting either edge wrong either spams a repeat commenter or silently
 * mutes a rule that was never actually cooling down.
 */
describe("isWithinCooldown", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  it("no cooldown configured never blocks, regardless of last run", () => {
    expect(isWithinCooldown(null, new Date(now.getTime() - 1_000), now)).toBe(false);
    expect(isWithinCooldown(undefined, new Date(now.getTime() - 1_000), now)).toBe(false);
  });

  it("no prior run never blocks, even with a cooldown configured", () => {
    expect(isWithinCooldown(3600, null, now)).toBe(false);
  });

  it("blocks when the last run is inside the window", () => {
    expect(isWithinCooldown(3600, new Date(now.getTime() - 60_000), now)).toBe(true);
  });

  it("allows again once the window has fully elapsed", () => {
    expect(isWithinCooldown(3600, new Date(now.getTime() - 3_600_001), now)).toBe(false);
  });

  it("the boundary itself (exactly the window) is no longer blocked", () => {
    expect(isWithinCooldown(3600, new Date(now.getTime() - 3_600_000), now)).toBe(false);
  });
});
