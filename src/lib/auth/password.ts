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

/** Minimum password length accepted for admin accounts. */
export const MIN_PASSWORD_LENGTH = 8;

/** Minimal but real policy for a private admin platform. */
export function checkPasswordPolicy(pw: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (pw.length < MIN_PASSWORD_LENGTH) problems.push(`at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) problems.push("upper and lower case letters");
  if (!/[0-9]/.test(pw)) problems.push("at least one digit");
  return { ok: problems.length === 0, problems };
}

/**
 * Login (username) rules: 3–40 chars, letters/digits/._- only.
 * Stored and compared lowercased so "Admin" and "admin" are the same account.
 */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function checkLoginFormat(login: string): PasswordPolicyResult {
  const problems: string[] = [];
  const value = login.trim();
  if (value.length < 3 || value.length > 40) problems.push("3–40 characters");
  if (!/^[A-Za-z0-9._-]+$/.test(value)) problems.push("only letters, digits, dot, underscore or hyphen");
  return { ok: problems.length === 0, problems };
}
