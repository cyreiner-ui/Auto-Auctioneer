import { createCipheriv, createHash, randomBytes } from "node:crypto";

function key() {
  const value = process.env.EBAY_TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("EBAY_TOKEN_ENCRYPTION_KEY is not configured.");
  return createHash("sha256").update(value).digest();
}

export function encryptToken(value: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
