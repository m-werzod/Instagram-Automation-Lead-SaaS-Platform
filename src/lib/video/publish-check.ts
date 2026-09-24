import { AppError } from "@/lib/errors";
import { assertCanPublish } from "@/lib/meta/publishing";

/**
 * Non-throwing form of the publishing permission check.
 *
 * The editor needs to *show* why a finished render cannot be published — a demo
 * account, a missing content-publish scope — next to the export, rather than
 * throwing when the operator clicks. The rule itself stays in one place
 * (assertCanPublish); this only changes how the answer is delivered.
 */
export function canPublishReason(account: Parameters<typeof assertCanPublish>[0]): { code: string; detail: string; fix: string } | null {
  try {
    assertCanPublish(account);
    return null;
  } catch (err) {
    if (err instanceof AppError) {
      return {
        code: err.code,
        detail: err.reason ?? err.message,
        fix: err.fix ?? "Reconnect the Instagram account with the publishing permission enabled.",
      };
    }
    return {
      code: "UNKNOWN",
      detail: err instanceof Error ? err.message : String(err),
      fix: "Check the account's connection on the Instagram page.",
    };
  }
}
