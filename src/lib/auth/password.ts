import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/** Minimal but real policy for a private admin platform. */
export function checkPasswordPolicy(pw: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (pw.length < 12) problems.push("at least 12 characters");
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) problems.push("upper and lower case letters");
  if (!/[0-9]/.test(pw)) problems.push("at least one digit");
  return { ok: problems.length === 0, problems };
}
