import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";

export const GET = route(async () => {
  const auth = await requireAdmin();
  return ok({ admin: auth.admin });
});
