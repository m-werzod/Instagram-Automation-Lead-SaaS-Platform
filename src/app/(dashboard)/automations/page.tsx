import { redirect } from "next/navigation";

/** Automation rules are a tab inside AI & Automation now. */
export default function AutomationsRedirect() {
  redirect("/automation?tab=rules");
}
