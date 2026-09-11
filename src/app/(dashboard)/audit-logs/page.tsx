import { redirect } from "next/navigation";

/** The activity log is a tab inside Settings now. */
export default function AuditLogsRedirect() {
  redirect("/settings?tab=audit");
}
