import { redirect } from "next/navigation";

/** Lead forms are managed by the Lead Button builder now. */
export default function LeadFlowsRedirect() {
  redirect("/lead-button");
}
