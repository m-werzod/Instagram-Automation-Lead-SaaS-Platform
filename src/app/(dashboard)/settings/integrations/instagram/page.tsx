import { redirect } from "next/navigation";

/** Instagram connection management moved to the unified /instagram page. */
export default function InstagramIntegrationRedirect() {
  redirect("/instagram");
}
