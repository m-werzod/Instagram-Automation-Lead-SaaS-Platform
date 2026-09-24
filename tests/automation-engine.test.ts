import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allConditionsMatch,
  conditionMatches,
  contentScopeMatches,
  flowIsUsableByAccount,
  isWithinCooldown,
  OUTBOUND_ACTIONS,
  runAutomations,
  type AutomationCondition,
  type TriggerContext,
} from "@/lib/automation/engine";

// The engine's decisions are pure (tested below); its WIRING is not, so the
// collaborators it reaches for are mocked — a unit test never touches a DB, a
// queue or Meta. The send layer's own payload rules live in messaging-rules.test.ts.
const db = vi.hoisted(() => ({
  automation: { findMany: vi.fn(), update: vi.fn() },
  automationRun: { create: vi.fn(), findFirst: vi.fn() },
  instagramAccount: { findUnique: vi.fn() },
  commentResource: { findUnique: vi.fn() },
  leadFlow: { findUnique: vi.fn() },
  conversation: { findUnique: vi.fn() },
  message: { create: vi.fn() },
  $transaction: vi.fn(),
}));
const settings = vi.hoisted(() => ({ masterAutomationEnabled: true, leadAutomationWhenOff: true }));
const messaging = vi.hoisted(() => ({ sendPrivateReplyResourceToComment: vi.fn(), sendInstagramText: vi.fn() }));
const leadflow = vi.hoisted(() => ({ startFlowSession: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/settings", () => ({ getGlobalSettings: async () => settings }));
vi.mock("@/lib/meta/messaging", () => messaging);
vi.mock("@/lib/leadflow/engine", () => leadflow);

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

/**
 * A START_LEAD_FLOW flowId is admin-supplied JSON on the rule, so ownership is
 * a RUN-time question: a flow belonging to another account must never answer
 * this account's customers (it would ask that account's questions and file the
 * lead under it), and a flowId that no longer resolves must not fall through.
 */
describe("flowIsUsableByAccount", () => {
  it("accepts a flow owned by the rule's own account", () => {
    expect(flowIsUsableByAccount({ accountId: "a1" }, "a1")).toBe(true);
  });

  it("rejects another account's flow", () => {
    expect(flowIsUsableByAccount({ accountId: "a2" }, "a1")).toBe(false);
  });

  it("rejects a flow that no longer exists", () => {
    expect(flowIsUsableByAccount(null, "a1")).toBe(false);
  });
});

/**
 * The wiring around those decisions, which the pure tests above cannot reach:
 * the ownership check must run BEFORE the flow engine is touched, and a run
 * that succeeded but could not deliver everything must still say so on the one
 * line the rule's history shows (AutomationRun.error) — the admin has no other
 * view of it.
 */
describe("runAutomations", () => {
  function rule(actions: unknown[], overrides: Record<string, unknown> = {}) {
    return { id: "rule_1", contentId: null, conditions: [], cooldownSec: null, actions, ...overrides };
  }
  /** The row the rule-history dialog renders for this run. */
  function lastRun(): { status: string; error?: string | null } {
    const calls = db.automationRun.create.mock.calls;
    return calls[calls.length - 1]?.[0]?.data;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    settings.masterAutomationEnabled = true;
    settings.leadAutomationWhenOff = true;
    db.automation.findMany.mockResolvedValue([]);
    db.automation.update.mockResolvedValue({});
    db.automationRun.create.mockResolvedValue({});
    db.automationRun.findFirst.mockResolvedValue(null);
    db.message.create.mockResolvedValue({});
    db.$transaction.mockImplementation(async (ops: Array<Promise<unknown>>) => Promise.all(ops));
    db.instagramAccount.findUnique.mockResolvedValue({ id: "acc_1", isDemo: true });
  });

  const resourceRule = [{ type: "SEND_COMMENT_RESOURCE", params: { mode: "template", text: "narxlar", resourceId: "res_1" } }];

  it("sends the resource once and records the caption it could not carry on a SUCCESSful run", async () => {
    db.automation.findMany.mockResolvedValue([rule(resourceRule)]);
    db.commentResource.findUnique.mockResolvedValue({ id: "res_1", mimeType: "image/jpeg", externalUrl: null });
    messaging.sendPrivateReplyResourceToComment.mockResolvedValue({
      result: { recipientId: "u1", messageId: "m1" },
      omittedText: "narxlar",
      omittedReason: "Instagram allows one private reply per comment, and an attachment message cannot carry text",
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1", text: "narx" });

    expect(messaging.sendPrivateReplyResourceToComment).toHaveBeenCalledTimes(1);
    expect(messaging.sendPrivateReplyResourceToComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acc_1" }),
      "cmt_1",
      "narxlar",
      { kind: "IMAGE", url: "http://localhost:3000/r/res_1.jpg" },
    );
    expect(lastRun().status).toBe("SUCCESS");
    expect(lastRun().error).toMatch(/caption not sent/);
  });

  it("leaves that line empty when everything was delivered", async () => {
    db.automation.findMany.mockResolvedValue([rule(resourceRule)]);
    db.commentResource.findUnique.mockResolvedValue({ id: "res_1", mimeType: "application/pdf", externalUrl: null });
    messaging.sendPrivateReplyResourceToComment.mockResolvedValue({
      result: { recipientId: "u1", messageId: "m1" },
      omittedText: null,
      omittedReason: null,
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1", text: "narx" });

    expect(lastRun().status).toBe("SUCCESS");
    expect(lastRun().error).toBeUndefined();
  });

  it("refuses to start another account's lead flow, without reaching the flow engine", async () => {
    db.automation.findMany.mockResolvedValue([rule([{ type: "START_LEAD_FLOW", params: { flowId: "flow_x" } }])]);
    db.leadFlow.findUnique.mockResolvedValue({ accountId: "acc_other" });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1" });

    expect(leadflow.startFlowSession).not.toHaveBeenCalled();
    expect(lastRun().status).toBe("FAILED");
    expect(lastRun().error).toMatch(/does not belong/);
  });

  it("starts the account's own lead flow", async () => {
    db.automation.findMany.mockResolvedValue([rule([{ type: "START_LEAD_FLOW", params: { flowId: "flow_1" } }])]);
    db.leadFlow.findUnique.mockResolvedValue({ accountId: "acc_1" });
    db.conversation.findUnique.mockResolvedValue({
      id: "conv_1",
      igsid: "u1",
      lastUserMessageAt: new Date(),
      account: { id: "acc_1", isDemo: true },
    });
    leadflow.startFlowSession.mockResolvedValue({ sessionStatus: "ACTIVE", messages: [{ text: "Ismingiz?" }] });
    messaging.sendInstagramText.mockResolvedValue({ recipientId: "u1", messageId: "m1" });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1" });

    expect(leadflow.startFlowSession).toHaveBeenCalledWith({
      flowId: "flow_1",
      accountId: "acc_1",
      conversationId: "conv_1",
    });
    expect(lastRun().status).toBe("SUCCESS");
  });

  it("the master switch blocks the send before the send layer is reached", async () => {
    settings.masterAutomationEnabled = false;
    db.automation.findMany.mockResolvedValue([rule(resourceRule)]);

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1", text: "narx" });

    expect(messaging.sendPrivateReplyResourceToComment).not.toHaveBeenCalled();
    expect(lastRun().status).toBe("FAILED");
    expect(lastRun().error).toMatch(/master automation switch OFF/);
  });
});
