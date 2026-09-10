import { z } from "zod";

/** Shared lead-flow question validation (route files must only export handlers). */
export const questionSchema = z.object({
  title: z.string().min(1).max(120),
  prompt: z.string().min(1).max(900),
  type: z.enum(["TEXT", "PHONE", "EMAIL", "NUMBER", "SINGLE_SELECT", "MULTI_SELECT", "DATE", "TIME", "BOOLEAN"]),
  required: z.boolean().default(true),
  options: z.array(z.string().min(1).max(80)).max(13).default([]),
  mapTo: z.enum(["name", "phone", "email"]).nullable().optional(),
  validationRegex: z.string().max(300).nullable().optional(),
});

export type QuestionInput = z.infer<typeof questionSchema>;
