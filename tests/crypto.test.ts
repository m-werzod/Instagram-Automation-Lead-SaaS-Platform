import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashSessionToken, hmacSha256, randomToken, safeEqual } from "@/lib/crypto";

describe("crypto", () => {
  it("encrypts and decrypts round-trip", () => {
    const secret = "IGQVJ-super-secret-access-token-1234567890";
    const blob = encryptSecret(secret);
    expect(blob).not.toContain(secret);
    expect(decryptSecret(blob)).toBe(secret);
  });

  it("produces different ciphertext per call (random IV)", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("rejects tampered ciphertext", () => {
    const blob = encryptSecret("token");
    const raw = Buffer.from(blob, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    expect(() => decryptSecret(raw.toString("base64"))).toThrow();
  });

  it("hashes session tokens deterministically with pepper", () => {
    const token = randomToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toBe(hashSessionToken(token + "x"));
    expect(hashSessionToken(token)).toHaveLength(64);
  });

  it("safeEqual compares constant-time-ish and correctly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("hmacSha256 matches known vector", () => {
    // verified: echo -n "payload" | openssl dgst -sha256 -hmac "key"
    expect(hmacSha256("key", "payload")).toBe(
      "5d98b45c90a207fa998ce639fea6f02ecc8cc3f36fef81d694fb856b4d0a28ca",
    );
  });
});
