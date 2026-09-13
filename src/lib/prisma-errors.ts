/**
 * Small shared check for Prisma's unique-constraint violation code. Existing
 * call sites (queue/handlers.ts, billing/service.ts, the Instagram webhook
 * route) inline this same check; new code should prefer this helper.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
}
