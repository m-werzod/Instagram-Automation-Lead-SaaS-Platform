import { redirect } from "next/navigation";

/** The knowledge base is a tab inside AI & Automation now. */
export default function KnowledgeRedirect() {
  redirect("/automation?tab=knowledge");
}
