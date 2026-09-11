import { redirect } from "next/navigation";

/** Analytics now lives on the Dashboard (its "Numbers" section). */
export default function AnalyticsRedirect() {
  redirect("/dashboard");
}
